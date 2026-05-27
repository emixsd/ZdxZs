const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { config } = require("./config");
const { createDocument, baixarArquivoAssinado } = require("./zapsign");
const { updateTicket, uploadAttachment, buscarTagsDoTicketObrigatorio } = require("./zendesk");
const { auditLog, maskIdentityDocument, validateEmail, validateIdentityDocument, sendErrorAlert } = require("./utils");
const {
  salvarJobZendesk,
  marcarCriacaoDocumentoIniciada,
  marcarDocumentoCriado,
  marcarJobFalhou,
  marcarJobRevisao,
  removerJobZendesk,
  carregarJobsRecuperaveis,
} = require("./jobStore");

const app = express();
app.set("trust proxy", 1); // Render usa proxy reverso

// ─── Raw body para validação HMAC ────────────────────────────────────────────
// Captura o body bruto antes do JSON.parse — necessário para validar
// HMAC corretamente (JSON.stringify pode reordenar/alterar o corpo)
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Muitas requisições. Tente novamente em 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: "Rate limit excedido no webhook." },
});

// ─── Proteção contra duplicatas ──────────────────────────────────────────────
// Evita criar 2+ documentos se o Zendesk disparar o trigger múltiplas vezes
const processando = new Set();
const tagsQueBloqueiamNovoDocumento = [
  "documento_enviado",
  "documento_assinado",
  "documento_recusado",
];

function encontrarTagBloqueio(tags) {
  return tagsQueBloqueiamNovoDocumento.find((tag) => tags.includes(tag)) || "";
}

// ─── Validação do Webhook Secret (Zendesk) ───────────────────────────────────
function validateWebhookSecret(req, res, next) {
  const incomingSecret = req.headers["x-webhook-secret"];
  if (!incomingSecret) {
    auditLog("WARN", "webhook_rejected", { ip: req.ip, reason: "Missing secret" });
    return res.status(401).json({ error: "Não autorizado." });
  }
  try {
    const a = Buffer.from(incomingSecret);
    const b = Buffer.from(config.WEBHOOK_SECRET);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new Error("Secret mismatch");
    }
  } catch {
    auditLog("WARN", "webhook_rejected", { ip: req.ip, reason: "Invalid secret" });
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

// ─── Autenticação do Webhook ZapSign (HMAC SHA-256) ──────────────────────────
// Usa raw body para calcular o HMAC — mais seguro que JSON.stringify
function validateZapSignSignature(req, res, next) {
  if (!config.zapsign.webhookSecret) {
    auditLog("INFO", "zapsign_hmac_skipped", { ip: req.ip });
    return next();
  }

  const signature = req.headers["x-zapsign-hmac-sha256"];
  if (!signature) {
    auditLog("WARN", "zapsign_webhook_rejected", { ip: req.ip, reason: "Missing signature" });
    return res.status(401).json({ error: "Não autorizado." });
  }
  try {
    const expected = crypto
      .createHmac("sha256", config.zapsign.webhookSecret)
      .update(req.rawBody)
      .digest("hex");
    const incomingBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
      throw new Error("Signature mismatch");
    }
  } catch {
    auditLog("WARN", "zapsign_webhook_rejected", { ip: req.ip, reason: "Invalid signature" });
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

function resumirDocumentoZapSign(doc) {
  const signer = doc.signers?.[0] || {};
  return {
    token: doc.token || "",
    sign_url: signer.sign_url || "",
    signer_email: signer.email || "",
    created_at: new Date().toISOString(),
  };
}

async function processarZendeskJob(job) {
  const dadosTicket = job.payload || {};
  const { ticket_id, email } = dadosTicket;

  if (processando.has(ticket_id)) {
    auditLog("INFO", "job_already_processing", { ticket_id });
    return;
  }

  processando.add(ticket_id);

  let creationStarted = false;

  try {
    let doc = null;
    let docState = job.zapsign_doc || null;

    if (job.status === "creating") {
      const reason = "Criacao ZapSign ficou em estado incerto antes do documento ser salvo no job.";
      await marcarJobRevisao(ticket_id, reason);
      auditLog("WARN", "job_needs_review_after_restart", { ticket_id, reason });
      await sendErrorAlert({
        title: "Revisao manual necessaria",
        ticket_id,
        email,
        error: reason,
      });
      return;
    }

    if (job.status === "document_created" && docState?.sign_url) {
      auditLog("INFO", "job_resumed_after_document_created", { ticket_id });
    } else {
      const tagsAtuais = await buscarTagsDoTicketObrigatorio(ticket_id);
      const tagBloqueio = encontrarTagBloqueio(tagsAtuais);

      if (tagBloqueio) {
        auditLog("INFO", "document_creation_skipped_by_tag", {
          ticket_id,
          tag: tagBloqueio,
        });
        await removerJobZendesk(ticket_id);
        return;
      }

      await marcarCriacaoDocumentoIniciada(ticket_id);
      creationStarted = true;
      doc = await createDocument(dadosTicket);
      docState = resumirDocumentoZapSign(doc);
      await marcarDocumentoCriado(ticket_id, docState);

      auditLog("INFO", "document_created", { ticket_id, email });
      if (Array.isArray(doc.answers)) {
        auditLog("INFO", "template_variables_filled", {
          ticket_id,
          variables: doc.answers.map((answer) => ({
            variable: answer.variable,
            value_present: String(answer.value || "").trim().length > 0,
            value_length: String(answer.value || "").length,
          })),
        });
      }
    }

    const signUrl = docState?.sign_url || doc?.signers?.[0]?.sign_url || "";

    await updateTicket(ticket_id, {
      comment: `📄 Documento enviado para assinatura.\n🔗 Link: ${signUrl}`,
      tagsAdicionar: ["documento_enviado"],
    });

    await removerJobZendesk(ticket_id);
    auditLog("INFO", "ticket_updated", { ticket_id, status: "documento_enviado" });
  } catch (err) {
    auditLog("ERROR", "processing_failed", {
      ticket_id,
      email,
      error: err.message,
      status: err.response?.status,
      response: err.response?.data,
    });

    try {
      if (creationStarted) {
        await marcarJobRevisao(
          ticket_id,
          `Erro apos inicio da criacao ZapSign: ${err.message}`
        );
      } else {
        await marcarJobFalhou(ticket_id, err);
      }
    } catch (jobErr) {
      auditLog("ERROR", "job_mark_failed_error", {
        ticket_id,
        error: jobErr.message,
      });
    }

    await sendErrorAlert({
      title: "❌ Falha ao enviar documento",
      ticket_id,
      email,
      error: err.message,
    });
  } finally {
    processando.delete(ticket_id);
  }
}

async function recuperarJobsPendentes() {
  try {
    const jobs = await carregarJobsRecuperaveis();
    if (jobs.length === 0) return;

    auditLog("WARN", "jobs_recovered_on_startup", { count: jobs.length });
    for (const job of jobs) {
      await processarZendeskJob(job);
    }
  } catch (err) {
    auditLog("ERROR", "job_recovery_failed", { error: err.message });
  }
}

// ─── Rota principal: Zendesk → ZapSign ───────────────────────────────────────
app.post("/webhook/zendesk", webhookLimiter, validateWebhookSecret, async (req, res) => {
  const { ticket_id, name, email, cpf, documento, passaporte, phone, template_id, valor } = req.body;
  const documentoIdentificacao = cpf || documento || passaporte;

  // 1. Proteção contra duplicatas
  if (processando.has(ticket_id)) {
    auditLog("INFO", "duplicate_ignored", { ticket_id });
    return res.status(200).json({ status: "already_processing", ticket_id });
  }

  // 2. Validação de entrada
  const errors = [];
  if (!ticket_id) errors.push("ticket_id é obrigatório");
  if (!name || name.trim().length < 2) errors.push("name inválido");
  if (!email || !validateEmail(email)) errors.push("email inválido");
  if (!documentoIdentificacao || !validateIdentityDocument(documentoIdentificacao)) errors.push("CPF ou passaporte inválido");
  if (!template_id && !config.zapsign.templateId && !config.zapsign.pdfUrl) {
    errors.push("template_id e obrigatorio quando ZAPSIGN_TEMPLATE_ID ou ZAPSIGN_PDF_URL nao estiver configurado");
  }

  if (errors.length > 0) {
    auditLog("WARN", "validation_failed", { ticket_id, email, errors });
    return res.status(400).json({ error: "Dados inválidos", details: errors });
  }

  // 3. Log de auditoria (documento mascarado)
  auditLog("INFO", "request_received", {
    ticket_id,
    email,
    name: name.trim(),
    documento: maskIdentityDocument(documentoIdentificacao),
  });

  const dadosTicket = {
    template_id,
    name,
    email,
    cpf: documentoIdentificacao,
    documento: documentoIdentificacao,
    phone,
    ticket_id,
    valor,
  };
  let job;

  try {
    job = await salvarJobZendesk(dadosTicket);
  } catch (err) {
    auditLog("ERROR", "job_persist_failed", {
      ticket_id,
      email,
      error: err.message,
    });
    return res.status(500).json({ error: "Falha ao registrar processamento." });
  }

  // Responde imediatamente ao Zendesk depois que o job esta salvo.
  res.status(200).json({ status: "processing", ticket_id });

  processarZendeskJob(job);
});

// ─── Rota: Webhook ZapSign ───────────────────────────────────────────────────
app.post("/webhook/zapsign", validateZapSignSignature, async (req, res) => {
  const eventType = req.body.event_type || req.body.event_action || "";
  const doc = req.body.document || req.body;

  auditLog("INFO", "zapsign_webhook_received", {
    event_type: eventType,
    status: doc.status || "unknown",
    external_id: doc.external_id || "none",
  });

  // Extrair ticket_id do external_id (formato: "zendesk-12345")
  const externalId = doc.external_id || "";
  const ticket_id = externalId.startsWith("zendesk-")
    ? externalId.replace("zendesk-", "")
    : externalId;

  // ── Documento assinado ──
  // Verifica doc.status === "signed" para garantir que TODOS os signatários
  // assinaram (não apenas 1 de N). Isso protege cenários com múltiplos signatários.
  const isFullySigned = ["doc_signed", "sign_doc", "signed"].includes(eventType)
    && doc.status === "signed";

  if (isFullySigned && ticket_id) {
    const signer_email = doc.signers?.[0]?.email || "";
    auditLog("INFO", "document_signed", { ticket_id, signer_email });
    res.status(200).json({ status: "ok" });

    try {
      const uploads = [];
      let signedFileUrl = doc.signed_file || "";
      let pdfMessage = "\nPDF assinado ainda nao estava disponivel na ZapSign.";

      try {
        const signedFile = await baixarArquivoAssinado(doc);

        if (signedFile) {
          signedFileUrl = signedFile.url;
          const filename = `documento-assinado-ticket-${ticket_id}.pdf`;
          const uploadToken = await uploadAttachment(filename, signedFile.buffer, 'application/pdf');

          if (uploadToken) {
            uploads.push(uploadToken);
            pdfMessage = "\nPDF assinado anexado neste comentario.";
            auditLog("INFO", "signed_pdf_uploaded", { ticket_id, filename });
          }
        }
      } catch (pdfErr) {
        pdfMessage = signedFileUrl
          ? `\nLink temporario do PDF assinado: ${signedFileUrl}`
          : "\nFalha ao anexar o PDF assinado automaticamente.";
        auditLog("ERROR", "signed_pdf_upload_failed", {
          ticket_id,
          error: pdfErr.message,
          status: pdfErr.response?.status,
          response: pdfErr.response?.data,
        });
      }

      await updateTicket(ticket_id, {
        comment: `✅ Documento assinado por ${signer_email}.${pdfMessage}`,
        tagsAdicionar: ["documento_assinado"],
        tagsRemover: ["documento_enviado"],
        uploads,
      });
      auditLog("INFO", "ticket_updated_signed", { ticket_id, signer_email });
    } catch (err) {
      auditLog("ERROR", "zapsign_webhook_failed", {
        ticket_id,
        error: err.message,
        status: err.response?.status,
        response: err.response?.data,
      });
      await sendErrorAlert({
        title: "❌ Falha ao processar assinatura",
        ticket_id,
        email: signer_email,
        error: err.message,
      });
    }
    return;
  }

  // ── Documento recusado ──
  const isRefused = ["doc_refused", "refused"].includes(eventType)
    || doc.status === "refused";

  if (isRefused && ticket_id) {
    const signer_email = doc.signers?.[0]?.email || "";
    const motivo = doc.refusal_reason || req.body.refusal_reason || "";
    auditLog("INFO", "document_refused", { ticket_id, signer_email, motivo });
    res.status(200).json({ status: "ok" });

    try {
      await updateTicket(ticket_id, {
        comment: `❌ Documento recusado por ${signer_email}.${motivo ? `\n📝 Motivo: ${motivo}` : ""}`,
        tagsAdicionar: ["documento_recusado"],
        tagsRemover: ["documento_enviado"],
      });
      auditLog("INFO", "ticket_updated_refused", { ticket_id, signer_email });
    } catch (err) {
      auditLog("ERROR", "zapsign_webhook_refused_failed", {
        ticket_id,
        error: err.message,
        status: err.response?.status,
        response: err.response?.data,
      });
    }
    return;
  }

  // ── Outros eventos (ignorados) ──
  auditLog("INFO", "zapsign_webhook_ignored", { event: eventType, status: doc.status });
  res.status(200).json({ status: "ignored" });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.2.0",
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  auditLog("INFO", "server_started", { port: PORT, version: "1.2.0" });
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  recuperarJobsPendentes();
});

const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { version: VERSION } = require("../package.json");
const { config } = require("./config");
const { createDocument, baixarArquivoAssinado } = require("./zapsign");
const { updateTicket, uploadAttachment, buscarTagsDoTicketObrigatorio } = require("./zendesk");
const {
  auditLog,
  maskEmail,
  maskIdentityDocument,
  validateEmail,
  validateIdentityDocument,
  sendErrorAlert,
  getExternalErrorInfo,
  isTransientError,
  requestMayHaveSucceeded,
} = require("./utils");
const {
  MAX_RETENTATIVAS,
  lerJob,
  salvarJobZendesk,
  agendarRetentativa,
  marcarCriacaoDocumentoIniciada,
  marcarDocumentoCriado,
  marcarJobFalhou,
  marcarJobRevisao,
  removerJobZendesk,
  carregarJobsRecuperaveis,
  limparJobsFinalizadosAntigos,
} = require("./jobStore");

const INTERVALO_WORKER_MS = 60 * 1000;
const INTERVALO_LIMPEZA_MS = 6 * 60 * 60 * 1000;
const TEMPO_MAX_ENCERRAMENTO_MS = 25 * 1000;

const app = express();
app.set("trust proxy", 1); // Render usa proxy reverso
app.disable("x-powered-by"); // não anunciar a tecnologia do servidor

let encerrando = false;

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Antes do parser JSON, para requisições bloqueadas não pagarem o custo do parse.
// /health fica de fora para não derrubar o health check do Render.
// Só requisições com erro contam: um disparo em massa legítimo do Zendesk
// (vários tickets de uma vez, mesmos IPs) não pode ser barrado.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimit.globalPer15Min,
  message: { error: "Muitas requisições. Tente novamente em 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip: (req) => req.path === "/health",
});
app.use(limiter);

app.use(express.json());

// Nos webhooks, conta apenas tentativas com secret inválido (401)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: config.rateLimit.webhookPerMin,
  message: { error: "Rate limit excedido no webhook." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
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

// ─── Validação de secret via header (timing-safe) ────────────────────────────
// Zendesk e ZapSign enviam um header customizado com secret estático,
// configurado no painel de cada plataforma.
function criarValidadorDeSecret(secret, eventoRejeicao) {
  return (req, res, next) => {
    const incomingSecret = req.headers["x-webhook-secret"];
    if (!incomingSecret) {
      auditLog("WARN", eventoRejeicao, { ip: req.ip, reason: "Missing secret" });
      return res.status(401).json({ error: "Não autorizado." });
    }
    try {
      const a = Buffer.from(incomingSecret);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw new Error("Secret mismatch");
      }
    } catch {
      auditLog("WARN", eventoRejeicao, { ip: req.ip, reason: "Invalid secret" });
      return res.status(401).json({ error: "Não autorizado." });
    }
    next();
  };
}

const validateWebhookSecret = criarValidadorDeSecret(
  config.WEBHOOK_SECRET,
  "webhook_rejected"
);

const validateZapSignSecret = criarValidadorDeSecret(
  config.zapsign.webhookSecret,
  "zapsign_webhook_rejected"
);

function resumirDocumentoZapSign(doc) {
  const signer = doc.signers?.[0] || {};
  return {
    token: doc.token || "",
    sign_url: signer.sign_url || "",
    signer_email: signer.email || "",
    created_at: new Date().toISOString(),
  };
}

function hasPhoneForDelivery(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^55/, "").length >= 10;
}

function textoOpcional(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return null; // tipo inesperado (objeto/array) — tratado como inválido
}

function mascararEmailOpcional(email) {
  return email ? maskEmail(email) : "";
}

// ─── Processamento do job Zendesk → ZapSign ──────────────────────────────────
// Etapas: "inicio" (nada criado) → "criando" (chamada à ZapSign em andamento)
// → "criado" (documento existe, falta avisar o ticket).
async function processarZendeskJob(jobRecebido) {
  const ticket_id = String(jobRecebido.ticket_id || jobRecebido.payload?.ticket_id || "");

  if (processando.has(ticket_id)) {
    auditLog("INFO", "job_already_processing", { ticket_id });
    return;
  }

  processando.add(ticket_id);

  let job = null;
  let etapa = "inicio";
  let docState = null;

  try {
    // Relê do disco: outro processamento pode ter concluído ou alterado o job
    job = await lerJob(ticket_id);
    if (!job) return;

    const dadosTicket = job.payload || {};
    docState = job.zapsign_doc || null;

    if (job.status === "creating") {
      // Só acontece se o processo caiu no meio da chamada à ZapSign
      const reason = "Criacao ZapSign ficou em estado incerto antes do documento ser salvo no job. "
        + "Verifique na ZapSign se o documento existe antes de reenviar.";
      await marcarJobRevisao(ticket_id, reason);
      auditLog("WARN", "job_needs_review_after_restart", { ticket_id, reason });
      await sendErrorAlert({
        title: "Revisao manual necessaria",
        ticket_id,
        email: dadosTicket.email,
        error: reason,
      });
      return;
    }

    if (job.status === "document_created") {
      etapa = "criado";
      auditLog("INFO", "job_resumed_after_document_created", { ticket_id });
    } else if (job.status === "pending") {
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
      etapa = "criando";
      const doc = await createDocument(dadosTicket);
      etapa = "criado";
      docState = resumirDocumentoZapSign(doc);
      await marcarDocumentoCriado(ticket_id, docState);

      auditLog("INFO", "document_created", { ticket_id, email: mascararEmailOpcional(dadosTicket.email) });
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
    } else {
      // failed / needs_review: nada a fazer automaticamente
      return;
    }

    const linkAssinatura = docState?.sign_url
      ? `🔗 Link: ${docState.sign_url}`
      : "🔗 Link de assinatura disponível no painel da ZapSign.";
    const avisoDocumento = dadosTicket.documento_valido === false
      ? "\n⚠️ O CPF/passaporte informado parece inválido. Confira o documento antes da assinatura."
      : "";

    await updateTicket(ticket_id, {
      comment: `📄 Documento enviado para assinatura.\n${linkAssinatura}${avisoDocumento}`,
      tagsAdicionar: ["documento_enviado"],
    });

    await removerJobZendesk(ticket_id);
    auditLog("INFO", "ticket_updated", { ticket_id, status: "documento_enviado" });
  } catch (err) {
    await tratarFalhaDoJob({ ticket_id, job, etapa, docState, err });
  } finally {
    processando.delete(ticket_id);
  }
}

async function tratarFalhaDoJob({ ticket_id, job, etapa, docState, err }) {
  const email = job?.payload?.email;
  const externalError = getExternalErrorInfo(err);
  auditLog("ERROR", "processing_failed", {
    ticket_id,
    etapa,
    email: mascararEmailOpcional(email),
    error: err.message,
    status: externalError.status,
    response_data: externalError.data,
  });

  const podeRepetir = isTransientError(err) && (job?.retries || 0) < MAX_RETENTATIVAS;

  try {
    if (etapa === "criando" && requestMayHaveSucceeded(err)) {
      // Timeout/5xx na criação: a ZapSign pode ter criado o documento.
      // Repetir automaticamente arriscaria mandar dois contratos ao cliente.
      const reason = `Criacao ZapSign sem confirmacao (${err.message}). `
        + "Verifique na ZapSign se o documento existe antes de reenviar.";
      await marcarJobRevisao(ticket_id, reason);
      await sendErrorAlert({ title: "Revisao manual necessaria", ticket_id, email, error: reason });
      return;
    }

    if (podeRepetir) {
      const patch = etapa === "criado"
        ? { status: "document_created", zapsign_doc: docState }
        : { status: "pending" };
      const atualizado = await agendarRetentativa(ticket_id, err, patch);
      auditLog("WARN", "job_retry_scheduled", {
        ticket_id,
        etapa,
        retries: atualizado?.retries,
        next_attempt_at: atualizado?.next_attempt_at,
      });
      return;
    }

    if (etapa === "criado") {
      const reason = `Documento criado na ZapSign, mas o ticket nao foi atualizado: ${err.message}`;
      await marcarJobRevisao(ticket_id, reason);
      await sendErrorAlert({ title: "❌ Documento criado, ticket não atualizado", ticket_id, email, error: reason });
      return;
    }

    await marcarJobFalhou(ticket_id, err);
    await sendErrorAlert({ title: "❌ Falha ao enviar documento", ticket_id, email, error: err.message });
  } catch (jobErr) {
    auditLog("ERROR", "job_mark_failed_error", {
      ticket_id,
      error: jobErr.message,
    });
    await sendErrorAlert({ title: "❌ Falha ao enviar documento", ticket_id, email, error: err.message });
  }
}

// ─── Worker: retentativas e recuperação após restart ─────────────────────────
let workerRodando = false;
let ultimaLimpeza = 0;

async function processarJobsPendentes() {
  if (workerRodando || encerrando) return;
  workerRodando = true;

  try {
    if (Date.now() - ultimaLimpeza > INTERVALO_LIMPEZA_MS) {
      ultimaLimpeza = Date.now();
      const removidos = await limparJobsFinalizadosAntigos();
      if (removidos > 0) {
        auditLog("INFO", "old_jobs_cleaned", { count: removidos });
      }
    }

    const jobs = (await carregarJobsRecuperaveis())
      .filter((job) => !processando.has(String(job.ticket_id)));
    if (jobs.length === 0) return;

    auditLog("INFO", "pending_jobs_found", { count: jobs.length });
    for (const job of jobs) {
      if (encerrando) break;
      await processarZendeskJob(job);
    }
  } catch (err) {
    auditLog("ERROR", "job_worker_failed", { error: err.message });
  } finally {
    workerRodando = false;
  }
}

// ─── Rota principal: Zendesk → ZapSign ───────────────────────────────────────
app.post("/webhook/zendesk", webhookLimiter, validateWebhookSecret, async (req, res) => {
  try {
    if (encerrando) {
      // 503 faz o Zendesk reenviar o webhook para a próxima instância
      return res.status(503).json({ error: "Servidor reiniciando. Tente novamente." });
    }

    const body = req.body || {};
    const ticket_id = String(body.ticket_id ?? "").trim();
    const name = textoOpcional(body.name);
    const email = textoOpcional(body.email);
    const phone = textoOpcional(body.phone);
    const template_id = textoOpcional(body.template_id);
    const valor = textoOpcional(body.valor);
    const documentoIdentificacao = textoOpcional(body.cpf || body.documento || body.passaporte);

    // Documento digitado errado não bloqueia o envio — só gera aviso no log e no ticket
    const documentoValido = validateIdentityDocument(documentoIdentificacao);
    const emailValido = !!email && validateEmail(email);
    const phoneValido = hasPhoneForDelivery(phone);
    const emailParaEnvio = emailValido ? email : "";

    // 1. Proteção contra duplicatas
    if (processando.has(ticket_id)) {
      auditLog("INFO", "duplicate_ignored", { ticket_id });
      return res.status(200).json({ status: "already_processing", ticket_id });
    }

    // 2. Validação de entrada
    const errors = [];
    // Apenas dígitos — o ticket_id é interpolado em URLs da API Zendesk
    if (!/^\d+$/.test(ticket_id)) errors.push("ticket_id inválido");
    if (!name || name.length < 2) errors.push("name inválido");
    if (!emailValido && !phoneValido) errors.push("email ou phone valido obrigatorio");
    if (!documentoIdentificacao) errors.push("CPF ou passaporte obrigatório");
    if (template_id === null || valor === null) errors.push("template_id/valor com formato inválido");
    if (!template_id && !config.zapsign.templateId && !config.zapsign.pdfUrl) {
      errors.push("template_id e obrigatorio quando ZAPSIGN_TEMPLATE_ID ou ZAPSIGN_PDF_URL nao estiver configurado");
    }

    if (errors.length > 0) {
      auditLog("WARN", "validation_failed", { ticket_id, email: mascararEmailOpcional(emailParaEnvio), errors });
      return res.status(400).json({ error: "Dados inválidos", details: errors });
    }

    // 3. Log de auditoria (dados pessoais mascarados)
    auditLog("INFO", "request_received", {
      ticket_id,
      email: mascararEmailOpcional(emailParaEnvio),
      documento: maskIdentityDocument(documentoIdentificacao),
      documento_valido: documentoValido,
    });

    if (!documentoValido) {
      auditLog("WARN", "identity_document_invalid_sent_anyway", {
        ticket_id,
        documento: maskIdentityDocument(documentoIdentificacao),
      });
    }

    const dadosTicket = {
      template_id,
      name,
      email: emailParaEnvio,
      cpf: documentoIdentificacao,
      documento: documentoIdentificacao,
      phone,
      ticket_id,
      valor,
      documento_valido: documentoValido,
    };

    let job;
    try {
      job = await salvarJobZendesk(dadosTicket);
    } catch (err) {
      auditLog("ERROR", "job_persist_failed", {
        ticket_id,
        email: mascararEmailOpcional(emailParaEnvio),
        error: err.message,
      });
      return res.status(500).json({ error: "Falha ao registrar processamento." });
    }

    if (job.status === "needs_review") {
      // Documento pode já existir na ZapSign — não recria automaticamente
      auditLog("WARN", "webhook_ignored_job_needs_review", { ticket_id });
      return res.status(200).json({ status: "needs_review", ticket_id });
    }

    // Responde imediatamente ao Zendesk depois que o job esta salvo.
    res.status(200).json({ status: "processing", ticket_id });

    processarZendeskJob(job);
  } catch (err) {
    auditLog("ERROR", "zendesk_webhook_unexpected_error", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
  }
});

// ─── Rota: Webhook ZapSign ───────────────────────────────────────────────────
async function processarDocumentoAssinado({ ticket_id, doc, signer_email }) {
  const tagsAtuais = await buscarTagsDoTicketObrigatorio(ticket_id);
  if (tagsAtuais.includes("documento_assinado")) {
    auditLog("INFO", "zapsign_webhook_duplicate_ignored", { ticket_id, event_type: "signed" });
    return;
  }

  const uploads = [];
  // Preenchida apenas com a URL vinda da API autenticada da ZapSign —
  // nunca com a URL do payload do webhook (risco de SSRF/link malicioso)
  let signedFileUrl = "";
  let pdfMessage = "\nPDF assinado ainda nao estava disponivel na ZapSign.";

  try {
    const signedFile = await baixarArquivoAssinado(doc);

    if (signedFile) {
      signedFileUrl = signedFile.url;
      const filename = `documento-assinado-ticket-${ticket_id}.pdf`;
      const uploadToken = await uploadAttachment(filename, signedFile.buffer, "application/pdf");

      if (uploadToken) {
        uploads.push(uploadToken);
        pdfMessage = "\nPDF assinado anexado neste comentario.";
        auditLog("INFO", "signed_pdf_uploaded", { ticket_id, filename });
      }
    }
  } catch (pdfErr) {
    const externalError = getExternalErrorInfo(pdfErr);
    pdfMessage = signedFileUrl
      ? `\nLink temporario do PDF assinado: ${signedFileUrl}`
      : "\nFalha ao anexar o PDF assinado automaticamente.";
    auditLog("ERROR", "signed_pdf_upload_failed", {
      ticket_id,
      error: pdfErr.message,
      status: externalError.status,
      response_data: externalError.data,
    });
  }

  const signedComment = `✅ Documento assinado por ${signer_email}.${pdfMessage}`;

  try {
    await updateTicket(ticket_id, {
      comment: signedComment,
      tagsAdicionar: ["documento_assinado"],
      tagsRemover: ["documento_enviado"],
      uploads,
    });
  } catch (ticketErr) {
    if (uploads.length === 0) throw ticketErr;

    const externalError = getExternalErrorInfo(ticketErr);
    auditLog("ERROR", "signed_ticket_update_with_upload_failed", {
      ticket_id,
      error: ticketErr.message,
      status: externalError.status,
      response_data: externalError.data,
    });

    const fallbackPdfMessage = signedFileUrl
      ? `\nNao consegui anexar o PDF automaticamente no Zendesk.\nLink temporario do PDF assinado: ${signedFileUrl}`
      : "\nNao consegui anexar o PDF automaticamente no Zendesk.";

    await updateTicket(ticket_id, {
      comment: `✅ Documento assinado por ${signer_email}.${fallbackPdfMessage}`,
      tagsAdicionar: ["documento_assinado"],
      tagsRemover: ["documento_enviado"],
    });
  }

  auditLog("INFO", "ticket_updated_signed", { ticket_id, signer_email: mascararEmailOpcional(signer_email) });
}

async function processarDocumentoRecusado({ ticket_id, signer_email, motivo }) {
  const tagsAtuais = await buscarTagsDoTicketObrigatorio(ticket_id);
  if (tagsAtuais.includes("documento_recusado")) {
    auditLog("INFO", "zapsign_webhook_duplicate_ignored", { ticket_id, event_type: "refused" });
    return;
  }

  await updateTicket(ticket_id, {
    comment: `❌ Documento recusado por ${signer_email}.${motivo ? `\n📝 Motivo: ${motivo}` : ""}`,
    tagsAdicionar: ["documento_recusado"],
    tagsRemover: ["documento_enviado"],
  });
  auditLog("INFO", "ticket_updated_refused", { ticket_id, signer_email: mascararEmailOpcional(signer_email) });
}

// Webhooks da ZapSign sendo processados após o 200 (aguardados no encerramento)
let webhooksZapSignEmAndamento = 0;

async function executarComAlerta(titulo, evento, { ticket_id, signer_email }, fn) {
  webhooksZapSignEmAndamento++;
  try {
    await fn();
  } catch (err) {
    const externalError = getExternalErrorInfo(err);
    auditLog("ERROR", evento, {
      ticket_id,
      error: err.message,
      status: externalError.status,
      response_data: externalError.data,
    });
    await sendErrorAlert({ title: titulo, ticket_id, email: signer_email, error: err.message });
  } finally {
    webhooksZapSignEmAndamento--;
  }
}

app.post("/webhook/zapsign", webhookLimiter, validateZapSignSecret, async (req, res) => {
  try {
    const body = req.body || {};
    const eventType = body.event_type || body.event_action || "";
    const doc = body.document || body;

    auditLog("INFO", "zapsign_webhook_received", {
      event_type: eventType,
      status: doc.status || "unknown",
      external_id: doc.external_id || "none",
    });

    // Extrair ticket_id do external_id (formato obrigatório: "zendesk-12345").
    // Documentos criados fora deste middleware nunca alteram tickets.
    const externalId = String(doc.external_id || "");
    const ticket_id = externalId.startsWith("zendesk-")
      ? externalId.slice("zendesk-".length)
      : "";
    // Apenas dígitos — o ticket_id é interpolado em URLs da API Zendesk
    const ticketIdValido = /^\d+$/.test(ticket_id);
    const signer_email = String(doc.signers?.[0]?.email || "");

    // ── Documento assinado ──
    // Verifica doc.status === "signed" para garantir que TODOS os signatários
    // assinaram (não apenas 1 de N). Isso protege cenários com múltiplos signatários.
    const isFullySigned = ["doc_signed", "sign_doc", "signed"].includes(eventType)
      && doc.status === "signed";

    if (isFullySigned && ticketIdValido) {
      auditLog("INFO", "document_signed", { ticket_id, signer_email: mascararEmailOpcional(signer_email) });
      res.status(200).json({ status: "ok" });
      await executarComAlerta(
        "❌ Falha ao processar assinatura",
        "zapsign_webhook_failed",
        { ticket_id, signer_email },
        () => processarDocumentoAssinado({ ticket_id, doc, signer_email })
      );
      return;
    }

    // ── Documento recusado ──
    const isRefused = ["doc_refused", "refused"].includes(eventType)
      || doc.status === "refused";

    if (isRefused && ticketIdValido) {
      const motivo = String(doc.refusal_reason || body.refusal_reason || "");
      auditLog("INFO", "document_refused", {
        ticket_id,
        signer_email: mascararEmailOpcional(signer_email),
        motivo_informado: motivo.length > 0,
      });
      res.status(200).json({ status: "ok" });
      await executarComAlerta(
        "❌ Falha ao registrar recusa",
        "zapsign_webhook_refused_failed",
        { ticket_id, signer_email },
        () => processarDocumentoRecusado({ ticket_id, signer_email, motivo })
      );
      return;
    }

    // ── Outros eventos (ignorados) ──
    auditLog("INFO", "zapsign_webhook_ignored", { event_type: eventType, status: doc.status });
    res.status(200).json({ status: "ignored" });
  } catch (err) {
    auditLog("ERROR", "zapsign_webhook_unexpected_error", { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Erro interno." });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: VERSION,
  });
});

// ─── Erros não tratados ───────────────────────────────────────────────────────
// Registra e alerta em vez de derrubar o processo silenciosamente.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  auditLog("ERROR", "unhandled_rejection", { error: message });
  sendErrorAlert({ title: "❌ Erro não tratado no middleware", error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = config.PORT || 3000;
const server = app.listen(PORT, () => {
  auditLog("INFO", "server_started", { port: PORT, version: VERSION });
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  processarJobsPendentes();
});

const worker = setInterval(processarJobsPendentes, INTERVALO_WORKER_MS);

// ─── Encerramento gracioso ───────────────────────────────────────────────────
// O Render manda SIGTERM a cada deploy. Esperar os jobs em andamento evita que
// uma criação interrompida vire "needs_review" sem necessidade.
function encerrar(signal) {
  if (encerrando) return;
  encerrando = true;
  clearInterval(worker);
  auditLog("INFO", "shutdown_started", { signal, jobs_em_andamento: processando.size });
  server.close();

  const inicio = Date.now();
  const aguardar = () => {
    const emAndamento = processando.size + webhooksZapSignEmAndamento;
    const tempoEsgotado = Date.now() - inicio > TEMPO_MAX_ENCERRAMENTO_MS;
    if (emAndamento === 0 || tempoEsgotado) {
      auditLog(tempoEsgotado ? "WARN" : "INFO", "shutdown_finished", {
        jobs_em_andamento: processando.size,
        webhooks_zapsign_em_andamento: webhooksZapSignEmAndamento,
      });
      process.exit(0);
    }
    setTimeout(aguardar, 500);
  };
  aguardar();
}

process.on("SIGTERM", () => encerrar("SIGTERM"));
process.on("SIGINT", () => encerrar("SIGINT"));

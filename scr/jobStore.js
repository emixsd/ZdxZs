const fs = require("fs/promises");
const path = require("path");
const { maskIdentityDocument, maskEmail } = require("./utils");

const jobsDir = process.env.JOB_STORAGE_DIR
  || path.join(process.cwd(), "data", "zendesk-jobs");

// Jobs nesses status nunca são reprocessados automaticamente — os dados
// completos ficam no ticket do Zendesk, então aqui podem ser mascarados.
const STATUS_FINAIS = ["failed", "needs_review"];
const RETENCAO_JOBS_FINALIZADOS_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

function mascararPayloadFinalizado(payload) {
  if (!payload) return payload;
  const masked = { ...payload };
  for (const campo of ["cpf", "documento", "passaporte"]) {
    if (masked[campo]) masked[campo] = maskIdentityDocument(masked[campo]);
  }
  if (masked.email) masked.email = maskEmail(masked.email);
  if (masked.phone) masked.phone = String(masked.phone).replace(/\d(?=\d{4})/g, "*");
  return masked;
}

function normalizarTicketId(ticketId) {
  return String(ticketId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function caminhoJob(ticketId) {
  return path.join(jobsDir, `${normalizarTicketId(ticketId)}.json`);
}

async function garantirDiretorio() {
  await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });
}

async function escreverJsonAtomico(filePath, data) {
  await garantirDiretorio();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmpPath, filePath);
}

async function lerJob(ticketId) {
  try {
    const raw = await fs.readFile(caminhoJob(ticketId), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function salvarJobZendesk(payload) {
  const ticketId = payload.ticket_id;
  const existing = await lerJob(ticketId);
  const now = new Date().toISOString();

  if (existing && ["pending", "creating", "document_created"].includes(existing.status)) {
    return existing;
  }

  const job = {
    id: normalizarTicketId(ticketId),
    ticket_id: String(ticketId),
    status: "pending",
    attempts: existing?.attempts || 0,
    created_at: existing?.created_at || now,
    updated_at: now,
    payload,
  };

  await escreverJsonAtomico(caminhoJob(ticketId), job);
  return job;
}

async function atualizarJobZendesk(ticketId, patch) {
  const existing = await lerJob(ticketId);
  if (!existing) return null;

  const job = {
    ...existing,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  if (STATUS_FINAIS.includes(job.status)) {
    job.payload = mascararPayloadFinalizado(job.payload);
  }

  await escreverJsonAtomico(caminhoJob(ticketId), job);
  return job;
}

async function marcarDocumentoCriado(ticketId, docState) {
  return atualizarJobZendesk(ticketId, {
    status: "document_created",
    zapsign_doc: docState,
  });
}

async function marcarCriacaoDocumentoIniciada(ticketId) {
  const existing = await lerJob(ticketId);
  return atualizarJobZendesk(ticketId, {
    status: "creating",
    attempts: (existing?.attempts || 0) + 1,
    creating_started_at: new Date().toISOString(),
  });
}

async function marcarJobRevisao(ticketId, reason) {
  return atualizarJobZendesk(ticketId, {
    status: "needs_review",
    review_reason: reason,
    review_requested_at: new Date().toISOString(),
  });
}

async function marcarJobFalhou(ticketId, err) {
  const existing = await lerJob(ticketId);
  return atualizarJobZendesk(ticketId, {
    status: "failed",
    attempts: (existing?.attempts || 0) + 1,
    // Sem err.response.data: o corpo da resposta pode ecoar CPF/dados pessoais
    last_error: {
      message: err.message,
      status: err.response?.status || null,
      failed_at: new Date().toISOString(),
    },
  });
}

async function removerJobZendesk(ticketId) {
  try {
    await fs.unlink(caminhoJob(ticketId));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function carregarJobsRecuperaveis() {
  await garantirDiretorio();
  const files = await fs.readdir(jobsDir);
  const jobs = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const raw = await fs.readFile(path.join(jobsDir, file), "utf8");
      const job = JSON.parse(raw);
      if (["pending", "creating", "document_created"].includes(job.status)) {
        jobs.push(job);
      }
    } catch {
      // Ignora arquivo corrompido para nao travar o startup.
    }
  }

  return jobs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

async function limparJobsFinalizadosAntigos() {
  await garantirDiretorio();
  const files = await fs.readdir(jobsDir);
  let removidos = 0;

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const raw = await fs.readFile(path.join(jobsDir, file), "utf8");
      const job = JSON.parse(raw);
      if (!STATUS_FINAIS.includes(job.status)) continue;

      const updatedAt = Date.parse(job.updated_at || job.created_at || "");
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > RETENCAO_JOBS_FINALIZADOS_MS) {
        await fs.unlink(path.join(jobsDir, file));
        removidos++;
      }
    } catch {
      // Ignora arquivo corrompido para nao travar o startup.
    }
  }

  return removidos;
}

module.exports = {
  salvarJobZendesk,
  marcarCriacaoDocumentoIniciada,
  marcarDocumentoCriado,
  marcarJobFalhou,
  marcarJobRevisao,
  removerJobZendesk,
  carregarJobsRecuperaveis,
  limparJobsFinalizadosAntigos,
};

const { config } = require("./config");

/**
 * Gera log estruturado com timestamp, nível e dados (sem CPF em texto puro).
 */
function auditLog(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry);

  if (level === "ERROR") {
    console.error(line);
  } else if (level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Valida formato básico de email.
 */
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase());
}

/**
 * Valida CPF com dígitos verificadores (algoritmo oficial).
 */
function validateCPF(cpf) {
  const clean = String(cpf).replace(/\D/g, "");
  if (clean.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(clean)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(clean[i]) * (10 - i);
  let rev = 11 - (sum % 11);
  if (rev >= 10) rev = 0;
  if (rev !== parseInt(clean[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(clean[i]) * (11 - i);
  rev = 11 - (sum % 11);
  if (rev >= 10) rev = 0;
  if (rev !== parseInt(clean[10])) return false;

  return true;
}

function normalizePassport(passport) {
  return String(passport || "").trim().replace(/[\s.-]/g, "").toUpperCase();
}

function validatePassport(passport) {
  const clean = normalizePassport(passport);
  if (!/^[A-Z0-9]{5,20}$/.test(clean)) return false;
  if (!/\d/.test(clean)) return false;
  if (/^([A-Z0-9])\1+$/.test(clean)) return false;
  return true;
}

function validateIdentityDocument(document) {
  const value = String(document || "").trim();
  if (!value) return false;

  const onlyDigits = value.replace(/\D/g, "");
  const looksLikeCpf = /^[\d.\-\s]+$/.test(value) && onlyDigits.length === 11;
  if (looksLikeCpf) {
    return validateCPF(value);
  }

  return validatePassport(value);
}

/**
 * Mascara CPF/passaporte para logs.
 */
function maskIdentityDocument(document) {
  if (!document) return "***";

  const onlyDigits = String(document).replace(/\D/g, "");
  if (onlyDigits.length === 11 && validateCPF(document)) {
    return `***.***.${onlyDigits.slice(6, 9)}-${onlyDigits.slice(9)}`;
  }

  const clean = normalizePassport(document);
  if (!clean) return "***";
  return `***${clean.slice(-3)}`;
}

/**
 * Mascara email para alertas externos (Slack).
 */
function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "***";
  return `${user.slice(0, 2)}***@${domain}`;
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")
    .replace(/\b(?:\+?55)?\d{10,13}\b/g, "[phone]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function sanitizeExternalErrorData(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return "[truncated]";

  if (typeof value === "string") {
    return redactSensitiveText(value).slice(0, 1000);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeExternalErrorData(item, depth + 1));
  }

  if (typeof value === "object") {
    const sensitiveKey = /(authorization|token|secret|password|cpf|documento|passaporte|email|phone|telefone|celular|name|nome|signer|signers)/i;
    return Object.fromEntries(
      Object.entries(value).slice(0, 30).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[redacted]" : sanitizeExternalErrorData(item, depth + 1),
      ])
    );
  }

  return String(value);
}

function getExternalErrorInfo(err) {
  return {
    status: err.response?.status || null,
    data: sanitizeExternalErrorData(err.response?.data),
  };
}

/**
 * Envia alerta de erro via Slack webhook (se configurado).
 */
async function sendErrorAlert({ title, ticket_id, email, error }) {
  if (!config.SLACK_WEBHOOK_URL) return;

  try {
    const payload = {
      text: `*${title}*`,
      attachments: [
        {
          color: "#FF0000",
          fields: [
            { title: "Ticket ID", value: String(ticket_id || "N/A"), short: true },
            { title: "Email", value: email ? maskEmail(email) : "N/A", short: true },
            { title: "Erro", value: error || "Erro desconhecido", short: false },
            { title: "Timestamp", value: new Date().toISOString(), short: true },
          ],
        },
      ],
    };

    const response = await fetch(config.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("Falha ao enviar alerta Slack:", response.status);
    }
  } catch (err) {
    console.error("Erro ao enviar alerta:", err.message);
  }
}

module.exports = {
  auditLog,
  maskCPF: maskIdentityDocument,
  maskIdentityDocument,
  maskEmail,
  validateEmail,
  validateCPF,
  validatePassport,
  validateIdentityDocument,
  getExternalErrorInfo,
  sanitizeExternalErrorData,
  sendErrorAlert,
};

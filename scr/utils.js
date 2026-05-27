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
            { title: "Email", value: email || "N/A", short: true },
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
  validateEmail,
  validateCPF,
  validatePassport,
  validateIdentityDocument,
  sendErrorAlert,
};

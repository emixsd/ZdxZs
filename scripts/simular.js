// Simula os webhooks do Zendesk e da ZapSign contra o middleware rodando localmente.
// Uso:
//   node scripts/simular.js zendesk <ticket_id> [cpf]
//   node scripts/simular.js assinado <ticket_id> <token_documento_zapsign>
//   node scripts/simular.js recusado <ticket_id> [motivo]
require("dotenv").config();

const BASE_URL = process.env.SIMULAR_URL || `http://localhost:${process.env.PORT || 3000}`;
const NOME = process.env.SIMULAR_NOME || "Cliente Teste";
const EMAIL = process.env.SIMULAR_EMAIL || "";
const TELEFONE = process.env.SIMULAR_TELEFONE || "";

async function enviar(rota, secret, body) {
  const response = await fetch(`${BASE_URL}${rota}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
    body: JSON.stringify(body),
  });
  console.log(`${response.status} ${await response.text()}`);
}

async function main() {
  const [acao, ticketId, extra] = process.argv.slice(2);

  if (!ticketId) {
    console.log("Uso: node scripts/simular.js <zendesk|assinado|recusado> <ticket_id> [cpf|token|motivo]");
    process.exit(1);
  }

  if (acao === "zendesk") {
    if (!EMAIL && !TELEFONE) {
      console.log("Defina SIMULAR_EMAIL (e/ou SIMULAR_TELEFONE) no .env — é para onde a ZapSign vai mandar o link.");
      process.exit(1);
    }
    return enviar("/webhook/zendesk", process.env.WEBHOOK_SECRET, {
      ticket_id: ticketId,
      name: NOME,
      email: EMAIL,
      phone: TELEFONE,
      cpf: extra || "529.982.247-25",
    });
  }

  if (acao === "assinado") {
    if (!extra) {
      console.log("Informe o token do documento (painel da ZapSign sandbox → documento).");
      process.exit(1);
    }
    return enviar("/webhook/zapsign", process.env.ZAPSIGN_WEBHOOK_SECRET, {
      event_type: "doc_signed",
      status: "signed",
      token: extra,
      external_id: `zendesk-${ticketId}`,
      signers: [{ email: EMAIL }],
    });
  }

  if (acao === "recusado") {
    return enviar("/webhook/zapsign", process.env.ZAPSIGN_WEBHOOK_SECRET, {
      event_type: "doc_refused",
      status: "refused",
      external_id: `zendesk-${ticketId}`,
      refusal_reason: extra || "Teste de recusa",
      signers: [{ email: EMAIL }],
    });
  }

  console.log(`Ação desconhecida: ${acao}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`Falha ao chamar ${BASE_URL}: ${err.message}. O servidor está rodando (npm start)?`);
  process.exit(1);
});

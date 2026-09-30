require("./setup-env");
const test = require("node:test");
const assert = require("node:assert/strict");
const jobStore = require("../scr/jobStore");

let seq = 1000;
function novoPayload() {
  return {
    ticket_id: String(seq++),
    name: "Maria Silva",
    email: "maria.silva@example.com",
    cpf: "529.982.247-25",
    documento: "529.982.247-25",
    phone: "11987654321",
  };
}

function erroTemporario() {
  const err = new Error("timeout");
  err.isAxiosError = true;
  err.code = "ECONNABORTED";
  return err;
}

test("novo webhook não sobrescreve job em needs_review", async () => {
  const payload = novoPayload();
  await jobStore.salvarJobZendesk(payload);
  await jobStore.marcarJobRevisao(payload.ticket_id, "incerto");

  const job = await jobStore.salvarJobZendesk(payload);
  assert.equal(job.status, "needs_review");
});

test("novo webhook recria job que falhou, com payload completo", async () => {
  const payload = novoPayload();
  await jobStore.salvarJobZendesk(payload);
  await jobStore.marcarJobFalhou(payload.ticket_id, new Error("x"));

  const falho = await jobStore.lerJob(payload.ticket_id);
  assert.equal(falho.payload.email, "ma***@example.com");

  const job = await jobStore.salvarJobZendesk(payload);
  assert.equal(job.status, "pending");
  assert.equal(job.payload.email, payload.email);
});

test("retentativa mantém dados sem máscara e respeita o backoff", async () => {
  const payload = novoPayload();
  await jobStore.salvarJobZendesk(payload);
  const job = await jobStore.agendarRetentativa(payload.ticket_id, erroTemporario(), { status: "pending" });

  assert.equal(job.status, "pending");
  assert.equal(job.retries, 1);
  assert.equal(job.payload.cpf, payload.cpf);

  const agora = Date.now();
  const prontosAgora = await jobStore.carregarJobsRecuperaveis(agora);
  assert.ok(!prontosAgora.some((j) => j.ticket_id === payload.ticket_id));

  const prontosDepois = await jobStore.carregarJobsRecuperaveis(agora + 2 * 60 * 1000);
  assert.ok(prontosDepois.some((j) => j.ticket_id === payload.ticket_id));
});

test("needs_review após criação mascara e-mail do signatário", async () => {
  const payload = novoPayload();
  await jobStore.salvarJobZendesk(payload);
  await jobStore.marcarDocumentoCriado(payload.ticket_id, {
    token: "abc",
    sign_url: "https://example.com/sign",
    signer_email: "maria.silva@example.com",
  });
  const job = await jobStore.marcarJobRevisao(payload.ticket_id, "ticket nao atualizado");

  assert.equal(job.zapsign_doc.signer_email, "ma***@example.com");
  assert.equal(job.zapsign_doc.sign_url, "https://example.com/sign");
  assert.equal(job.payload.cpf, "***.***.247-25");
});

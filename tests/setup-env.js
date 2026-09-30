// Variáveis mínimas para o config.js não encerrar o processo nos testes
const os = require("os");
const path = require("path");
const fs = require("fs");

Object.assign(process.env, {
  ZAPSIGN_API_TOKEN: "test",
  ZAPSIGN_WEBHOOK_SECRET: "test",
  ZENDESK_SUBDOMAIN: "test",
  ZENDESK_EMAIL: "test@example.com",
  ZENDESK_API_TOKEN: "test",
  WEBHOOK_SECRET: "test",
  JOB_STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "zxz-jobs-")),
});

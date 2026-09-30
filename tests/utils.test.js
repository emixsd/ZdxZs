require("./setup-env");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateIdentityDocument,
  maskIdentityDocument,
  maskEmail,
  isTransientError,
  requestMayHaveSucceeded,
} = require("../scr/utils");

function axiosError({ status, code } = {}) {
  const err = new Error("request failed");
  err.isAxiosError = true;
  if (code) err.code = code;
  if (status) err.response = { status, data: {} };
  return err;
}

test("valida CPF e passaporte", () => {
  assert.equal(validateIdentityDocument("529.982.247-25"), true);
  assert.equal(validateIdentityDocument("529.982.247-24"), false);
  assert.equal(validateIdentityDocument("111.111.111-11"), false);
  assert.equal(validateIdentityDocument("FZ123456"), true);
  assert.equal(validateIdentityDocument(""), false);
  assert.equal(validateIdentityDocument(null), false);
});

test("mascara documento e e-mail", () => {
  assert.equal(maskIdentityDocument("529.982.247-25"), "***.***.247-25");
  assert.equal(maskIdentityDocument("FZ123456"), "***456");
  assert.equal(maskEmail("emily.dias@heroseguros.com.br"), "em***@heroseguros.com.br");
  assert.equal(maskEmail("invalido"), "***");
});

test("isTransientError: só erros de API temporários", () => {
  assert.equal(isTransientError(axiosError({ code: "ECONNABORTED" })), true);
  assert.equal(isTransientError(axiosError({ status: 429 })), true);
  assert.equal(isTransientError(axiosError({ status: 503 })), true);
  assert.equal(isTransientError(axiosError({ status: 400 })), false);
  assert.equal(isTransientError(axiosError({ status: 404 })), false);
  assert.equal(isTransientError(new TypeError("bug")), false);
});

test("requestMayHaveSucceeded: timeout/5xx são incertos, 4xx e sem conexão não", () => {
  assert.equal(requestMayHaveSucceeded(axiosError({ code: "ECONNABORTED" })), true);
  assert.equal(requestMayHaveSucceeded(axiosError({ status: 502 })), true);
  assert.equal(requestMayHaveSucceeded(axiosError({ code: "ECONNREFUSED" })), false);
  assert.equal(requestMayHaveSucceeded(axiosError({ code: "ENOTFOUND" })), false);
  assert.equal(requestMayHaveSucceeded(axiosError({ status: 429 })), false);
  assert.equal(requestMayHaveSucceeded(axiosError({ status: 400 })), false);
  assert.equal(requestMayHaveSucceeded(new TypeError("bug")), false);
});

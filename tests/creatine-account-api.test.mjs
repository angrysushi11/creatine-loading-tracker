import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/creatine-account.js";

function responseDouble() {
  return {
    body: null,
    headers: {},
    statusCode: 0,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("account deletion endpoint allows only DELETE", async () => {
  const response = responseDouble();
  await handler({ method: "POST", headers: {} }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "DELETE");
  assert.equal(response.body.code, "METHOD_NOT_ALLOWED");
});

test("account deletion endpoint rejects a foreign browser origin before auth", async () => {
  const response = responseDouble();
  await handler({ method: "DELETE", headers: { origin: "https://attacker.example", authorization: "Bearer fake" } }, response);
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, "ORIGIN_NOT_ALLOWED");
});

test("account deletion endpoint requires a bearer token", async () => {
  const response = responseDouble();
  await handler({ method: "DELETE", headers: { origin: "https://doubledash.me" } }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
});

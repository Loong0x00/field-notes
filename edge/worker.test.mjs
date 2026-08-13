import assert from "node:assert/strict";
import test from "node:test";

import worker, { isBackendPath, proxyBackend } from "./worker.js";

test("only backend paths enter the proxy", () => {
  assert.equal(isBackendPath("/v1/config"), true);
  assert.equal(isBackendPath("/media/example"), true);
  assert.equal(isBackendPath("/healthz"), true);
  assert.equal(isBackendPath("/notes/example/"), false);
  assert.equal(isBackendPath("/v10/not-api"), false);
});

test("unsafe cross-origin requests are rejected before reaching the origin", async () => {
  let called = false;
  const request = new Request("https://loong0x00.com/v1/auth/login", {
    method: "POST",
    headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
    body: "{}",
  });
  const response = await proxyBackend(request, { ORIGIN_AUTH_SECRET: "secret" }, async () => {
    called = true;
    return new Response();
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("same-origin API requests are rewritten and signed", async () => {
  const request = new Request("https://loong0x00.com/v1/auth/login?mode=test", {
    method: "POST",
    headers: {
      Origin: "https://loong0x00.com",
      "CF-Connecting-IP": "2001:db8::1",
      "Content-Type": "application/json",
      "X-Field-Notes-Edge-Secret": "spoofed",
      "X-Field-Notes-Client-IP": "192.0.2.1",
    },
    body: "{}",
  });
  const response = await proxyBackend(request, { ORIGIN_AUTH_SECRET: "real-secret" }, async (upstream) => {
    assert.equal(upstream.url, "https://loong-field-notes.loong.chatgpt.site/v1/auth/login?mode=test");
    assert.equal(upstream.headers.get("Origin"), "https://loong-field-notes.loong.chatgpt.site");
    assert.equal(upstream.headers.get("X-Field-Notes-Edge-Secret"), "real-secret");
    assert.equal(upstream.headers.get("X-Field-Notes-Client-IP"), "2001:db8::1");
    assert.equal(upstream.headers.get("X-Forwarded-Host"), "loong0x00.com");
    return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("unknown hosts fail closed", async () => {
  const response = await worker.fetch(new Request("https://unrelated.example/"), {});
  assert.equal(response.status, 421);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const origin = new URL(base).origin;
let cookie = "";

async function request(path, options = {}, expected = 200) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("Cookie", cookie);
  if (options.body && typeof options.body === "string") headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && !headers.has("Origin")) headers.set("Origin", origin);
  const response = await fetch(`${base}${path}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  if (response.status !== expected) {
    assert.fail(`${options.method || "GET"} ${path}: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function json(path, options = {}, expected = 200) {
  return (await request(path, options, expected)).json();
}

const suffix = Date.now().toString(36).slice(-7);
const username = `e2e_${suffix}`;
const article = `e2e-${suffix}`;
const password = `First-${suffix}-pass`;
const newPassword = `Second-${suffix}-pass`;

assert.match((await request("/")).headers.get("content-type") || "", /text\/html/);
await request("/account/");
assert.deepEqual(await json("/healthz"), { status: "ok" });

await request("/v1/auth/register", {
  method: "POST",
  headers: { Origin: "https://attacker.invalid" },
  body: JSON.stringify({ username, password, turnstile_token: "" }),
}, 403);

const registration = await json("/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ username, password, turnstile_token: "" }),
}, 201);
assert.equal(registration.user.username, username);
assert.match(registration.recovery_code, /^[A-Z0-9-]+$/);
assert.equal((await json("/v1/auth/session")).user.username, username);

const image = await readFile(new URL("../assets/og.png", import.meta.url));
const form = new FormData();
form.append("file", new Blob([image], { type: "image/png" }), "test.png");
const upload = await json("/v1/uploads", { method: "POST", body: form }, 201);
assert.equal(upload.attachment.media_type, "image/png");

const root = await json(`/v1/articles/${article}/comments`, {
  method: "POST",
  body: JSON.stringify({ body: "root comment", parent_id: null, attachment_ids: [upload.attachment.id] }),
}, 201);
const reply = await json(`/v1/articles/${article}/comments`, {
  method: "POST",
  body: JSON.stringify({ body: "reply comment", parent_id: root.id, attachment_ids: [] }),
}, 201);
const listed = await json(`/v1/articles/${article}/comments`);
assert.equal(listed.comments.length, 2);
assert.equal((await request(upload.attachment.url)).headers.get("content-type"), "image/png");

await request(`/v1/comments/${reply.id}`, {
  method: "PATCH",
  body: JSON.stringify({ body: "edited reply", attachment_ids: [] }),
}, 204);
await request(`/v1/comments/${root.id}`, { method: "DELETE" }, 204);
await request(upload.attachment.url, {}, 404);

await request("/v1/auth/logout", { method: "POST" }, 204);
assert.equal((await json("/v1/auth/session")).user, null);
await json("/v1/auth/login", {
  method: "POST",
  body: JSON.stringify({ username, password, turnstile_token: "" }),
});
const recovery = await json("/v1/auth/recover", {
  method: "POST",
  body: JSON.stringify({ username, password: newPassword, recovery_code: registration.recovery_code, turnstile_token: "" }),
});
assert.notEqual(recovery.recovery_code, registration.recovery_code);
assert.equal(recovery.user.username, username);

console.log(`Worker E2E passed for ${username}`);

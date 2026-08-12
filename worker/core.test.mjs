import assert from "node:assert/strict";
import test from "node:test";

import {
  hashPassword,
  newRecoveryCode,
  normalizeRecoveryCode,
  normalizeUsername,
  validatePassword,
  verifyPassword,
} from "./auth.js";
import { detectImage } from "./media.js";
import worker from "./index.js";

test("password hashing and validation", async () => {
  validatePassword("correct horse battery staple");
  const encoded = await hashPassword("correct horse battery staple");
  assert.match(encoded, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword(encoded, "correct horse battery staple"), true);
  assert.equal(await verifyPassword(encoded, "incorrect horse battery staple"), false);
  assert.throws(() => validatePassword("too short"), /10/);
});

test("username and recovery normalization", async () => {
  assert.deepEqual(normalizeUsername(" Alice_1 "), { username: "Alice_1", normalized: "alice_1" });
  assert.throws(() => normalizeUsername("not allowed!"), /用户名/);
  const recovery = await newRecoveryCode();
  assert.match(recovery.display, /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){7}$/);
  assert.equal(normalizeRecoveryCode(recovery.display.toLowerCase()), recovery.display.replaceAll("-", ""));
});

test("image detector accepts PNG metadata and rejects fake files", () => {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 2, 0, 0, 0, 3,
  ]);
  assert.deepEqual(detectImage(png), { mediaType: "image/png", width: 2, height: 3 });
  assert.throws(() => detectImage(new TextEncoder().encode("<script>alert(1)</script>")), /JPEG、PNG 或 WebP/);
});

test("www host redirects to the canonical host", async () => {
  const response = await worker.fetch(
    new Request("https://www.loong0x00.com/account/?next=%2Fnotes%2F"),
    {},
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("Location"), "https://loong0x00.com/account/?next=%2Fnotes%2F");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

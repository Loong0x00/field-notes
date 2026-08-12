import {
  HTTPError,
  SESSION_SECONDS,
  apiError,
  base64url,
  clearSessionCookie,
  constantTimeEqual,
  currentUser,
  fromBase64url,
  json,
  nowSeconds,
  parseCookies,
  randomBytes,
  randomID,
  rateLimitCount,
  readJSON,
  recordRateLimit,
  requestIP,
  resetRateLimit,
  setSessionCookie,
  sha256,
  takeRateLimit,
  SESSION_COOKIE,
} from "./utils.js";

const USERNAME = /^[A-Za-z0-9_-]{3,24}$/;
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 rounds.
const PASSWORD_ITERATIONS = 100_000;
const encoder = new TextEncoder();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeUsername(value) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!USERNAME.test(username)) {
    throw new HTTPError(400, "invalid_username", "用户名必须为 3–24 位，只能包含英文字母、数字、下划线和连字符。");
  }
  return { username, normalized: username.toLowerCase() };
}

export function validatePassword(value) {
  if (typeof value !== "string" || [...value].length < 10) {
    throw new HTTPError(400, "invalid_password", "密码至少需要 10 个字符。");
  }
  if (encoder.encode(value).byteLength > 256) {
    throw new HTTPError(400, "invalid_password", "密码不能超过 256 字节。");
  }
  return value;
}

async function derivePassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(encoded, password) {
  const [algorithm, iterationsText, saltText, hashText] = String(encoded).split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations !== PASSWORD_ITERATIONS) {
    return false;
  }
  try {
    const expected = fromBase64url(hashText);
    const actual = await derivePassword(password, fromBase64url(saltText), iterations);
    return constantTimeEqual(expected, actual);
  } catch {
    return false;
  }
}

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function normalizeRecoveryCode(value) {
  return typeof value === "string" ? value.trim().replaceAll("-", "").toUpperCase() : "";
}

export async function newRecoveryCode() {
  const plain = base32(randomBytes(20));
  const groups = plain.match(/.{1,4}/g) || [];
  const display = groups.join("-");
  return { display, hash: await sha256(normalizeRecoveryCode(display)) };
}

async function verifyTurnstile(request, env, token) {
  if (env.ALLOW_NO_TURNSTILE === "true") return true;
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = requestIP(request);
  if (ip !== "unknown") body.set("remoteip", ip);
  let response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const result = await response.json().catch(() => null);
  if (!result?.success) return false;
  const host = new URL(request.url).hostname;
  return !result.hostname || result.hostname === host;
}

async function createSession(env, userId) {
  const token = randomID(32);
  const tokenHash = await sha256(token);
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
    env.DB.prepare(`
      INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)
    `).bind(tokenHash, userId, now, now + SESSION_SECONDS),
  ]);
  return token;
}

export async function bootstrapAdmin(env) {
  const usernameValue = env.ADMIN_BOOTSTRAP_USERNAME;
  const passwordValue = env.ADMIN_BOOTSTRAP_PASSWORD;
  const recoveryValue = env.ADMIN_BOOTSTRAP_RECOVERY_CODE;
  if (!usernameValue || !passwordValue || !recoveryValue) return;
  const { username, normalized } = normalizeUsername(usernameValue);
  if (await env.DB.prepare("SELECT id FROM users WHERE username_norm = ?1").bind(normalized).first()) return;
  const password = validatePassword(passwordValue);
  const passwordHash = await hashPassword(password);
  const recoveryHash = await sha256(normalizeRecoveryCode(recoveryValue));
  try {
    await env.DB.prepare(`
      INSERT INTO users(username, username_norm, password_hash, recovery_hash, role, created_at)
      VALUES (?1, ?2, ?3, ?4, 'admin', ?5)
    `).bind(username, normalized, passwordHash, recoveryHash, nowSeconds()).run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("unique")) throw error;
  }
}

async function register(request, env) {
  const ip = requestIP(request);
  if (!await takeRateLimit(env, `register:${ip}`, 5, 3600)) {
    throw new HTTPError(429, "rate_limited", "注册过于频繁，请稍后再试。");
  }
  const input = await readJSON(request, ["username", "password", "turnstile_token"]);
  const { username, normalized } = normalizeUsername(input.username);
  const password = validatePassword(input.password);
  if (!await verifyTurnstile(request, env, input.turnstile_token)) {
    throw new HTTPError(400, "turnstile_failed", "人机验证失败，请重试。");
  }
  const recovery = await newRecoveryCode();
  let result;
  try {
    result = await env.DB.prepare(`
      INSERT INTO users(username, username_norm, password_hash, recovery_hash, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(username, normalized, await hashPassword(password), recovery.hash, nowSeconds()).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) {
      throw new HTTPError(409, "username_unavailable", "这个用户名不可用。");
    }
    throw error;
  }
  const user = { id: Number(result.meta.last_row_id), username, role: "user" };
  const response = json({ user, recovery_code: recovery.display }, 201);
  return setSessionCookie(response, await createSession(env, user.id));
}

async function login(request, env) {
  const input = await readJSON(request, ["username", "password", "turnstile_token"]);
  let normalized;
  try {
    normalized = normalizeUsername(input.username).normalized;
  } catch {
    normalized = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  }
  const ip = requestIP(request);
  if (!await takeRateLimit(env, `login-all:${ip}`, 30, 15 * 60)) {
    throw new HTTPError(429, "rate_limited", "登录尝试过于频繁，请稍后再试。");
  }
  const failureKey = `login-fail:${ip}:${normalized}`;
  if (await rateLimitCount(env, failureKey, 15 * 60) >= 5 && !await verifyTurnstile(request, env, input.turnstile_token)) {
    throw new HTTPError(400, "turnstile_required", "请先完成人机验证。");
  }
  const row = await env.DB.prepare(`
    SELECT id, username, role, password_hash, banned_at FROM users WHERE username_norm = ?1
  `).bind(normalized).first();
  if (!row || row.banned_at !== null || !await verifyPassword(row.password_hash, String(input.password || ""))) {
    await recordRateLimit(env, failureKey, 15 * 60);
    throw new HTTPError(401, "invalid_credentials", "用户名或密码错误。");
  }
  await resetRateLimit(env, failureKey);
  const user = { id: Number(row.id), username: row.username, role: row.role };
  return setSessionCookie(json({ user }), await createSession(env, user.id));
}

async function logout(request, env) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await sha256(token)).run();
  return clearSessionCookie(new Response(null, { status: 204 }));
}

async function recover(request, env) {
  const ip = requestIP(request);
  if (!await takeRateLimit(env, `recover:${ip}`, 8, 3600)) {
    throw new HTTPError(429, "rate_limited", "恢复尝试过于频繁，请稍后再试。");
  }
  const input = await readJSON(request, ["username", "password", "recovery_code", "turnstile_token"]);
  let normalized = "";
  try { normalized = normalizeUsername(input.username).normalized; } catch { /* keep generic failure */ }
  const password = validatePassword(input.password);
  if (!await verifyTurnstile(request, env, input.turnstile_token)) {
    throw new HTTPError(400, "turnstile_failed", "人机验证失败，请重试。");
  }
  const user = await env.DB.prepare(`
    SELECT id, username, role, recovery_hash FROM users WHERE username_norm = ?1 AND banned_at IS NULL
  `).bind(normalized).first();
  const suppliedHash = await sha256(normalizeRecoveryCode(input.recovery_code));
  if (!user || suppliedHash !== user.recovery_hash) {
    throw new HTTPError(401, "invalid_recovery", "用户名或恢复信息无效。");
  }
  const recovery = await newRecoveryCode();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?1, recovery_hash = ?2 WHERE id = ?3")
      .bind(await hashPassword(password), recovery.hash, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
  ]);
  const responseUser = { id: Number(user.id), username: user.username, role: user.role };
  const response = json({ user: responseUser, recovery_code: recovery.display });
  return setSessionCookie(response, await createSession(env, responseUser.id));
}

export async function handleAuth(request, env, pathname) {
  if (request.method === "GET" && pathname === "/v1/auth/session") {
    return json({ user: await currentUser(request, env) });
  }
  if (request.method === "POST" && pathname === "/v1/auth/register") return register(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/login") return login(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/logout") return logout(request, env);
  if (request.method === "POST" && pathname === "/v1/auth/recover") return recover(request, env);
  return apiError(404, "not_found", "接口不存在。");
}

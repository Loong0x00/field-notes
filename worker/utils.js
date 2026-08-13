export const SESSION_COOKIE = "field_notes_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

export class HTTPError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

export function apiError(status, code, message) {
  return json({ error: { code, message } }, status);
}

export function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function requestIP(request, env = {}) {
  const suppliedSecret = request.headers.get("X-Field-Notes-Edge-Secret") || "";
  const expectedSecret = env.EDGE_PROXY_SECRET || "";
  const forwardedIP = request.headers.get("X-Field-Notes-Client-IP") || "";
  const trustedProxy = suppliedSecret && expectedSecret && constantTimeEqual(
    encoder.encode(suppliedSecret),
    encoder.encode(expectedSecret),
  );
  if (trustedProxy && forwardedIP.length <= 45 && /^(?=.*[.:])[0-9a-f:.]+$/i.test(forwardedIP)) {
    return forwardedIP;
  }
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

export function requireSameOrigin(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HTTPError(403, "origin_not_allowed", "请求来源不被允许。");
  }
}

export async function readJSON(request, allowedKeys) {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HTTPError(415, "json_required", "请求必须使用 JSON。");
  }
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > 32 * 1024) throw new HTTPError(413, "request_too_large", "请求内容过大。");
  const text = await request.text();
  if (encoder.encode(text).byteLength > 32 * 1024) {
    throw new HTTPError(413, "request_too_large", "请求内容过大。");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HTTPError(400, "invalid_json", "请求内容无效。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HTTPError(400, "invalid_json", "请求内容必须是 JSON 对象。");
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw new HTTPError(400, "invalid_json", "请求包含未知字段。");
  }
  return value;
}

export function parseCookies(request) {
  const result = new Map();
  for (const item of (request.headers.get("Cookie") || "").split(";")) {
    const position = item.indexOf("=");
    if (position < 1) continue;
    result.set(item.slice(0, position).trim(), item.slice(position + 1).trim());
  }
  return result;
}

export function setSessionCookie(response, token) {
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}

export function clearSessionCookie(response) {
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}

export function randomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function randomID(size = 18) {
  return base64url(randomBytes(size));
}

export function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function nowMilliseconds() {
  return Date.now();
}

export async function currentUser(request, env) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const user = await env.DB.prepare(`
    SELECT users.id, users.username, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2 AND users.banned_at IS NULL
  `).bind(tokenHash, nowSeconds()).first();
  return user || null;
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HTTPError(401, "authentication_required", "请先登录。");
  return user;
}

export async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (user.role !== "admin") throw new HTTPError(403, "admin_required", "需要站点管理员权限。");
  return user;
}

export async function takeRateLimit(env, key, limit, windowSeconds) {
  const now = nowSeconds();
  const row = await env.DB.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?1").bind(key).first();
  if (!row || Number(row.reset_at) <= now) {
    await env.DB.prepare(`
      INSERT INTO rate_limits(key, count, reset_at) VALUES (?1, 1, ?2)
      ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at
    `).bind(key, now + windowSeconds).run();
    return true;
  }
  if (Number(row.count) >= limit) return false;
  await env.DB.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?1").bind(key).run();
  return true;
}

export async function rateLimitCount(env, key, windowSeconds) {
  const now = nowSeconds();
  const row = await env.DB.prepare("SELECT count, reset_at FROM rate_limits WHERE key = ?1").bind(key).first();
  if (!row || Number(row.reset_at) <= now || Number(row.reset_at) > now + windowSeconds) return 0;
  return Number(row.count);
}

export async function resetRateLimit(env, key) {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
}

export async function recordRateLimit(env, key, windowSeconds) {
  const now = nowSeconds();
  await env.DB.prepare(`
    INSERT INTO rate_limits(key, count, reset_at) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
  `).bind(key, now + windowSeconds, now).run();
}

export function noContent() {
  return new Response(null, { status: 204 });
}

import { bootstrapAdmin, handleAuth } from "./auth.js";
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
  moderateComment,
  moderateUser,
} from "./comments.js";
import { serveMedia, upload } from "./media.js";
import { HTTPError, apiError, json, requireSameOrigin, secure } from "./utils.js";

function routeMatch(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function api(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  requireSameOrigin(request);
  await bootstrapAdmin(env);

  if (request.method === "GET" && pathname === "/healthz") return json({ status: "ok" });
  if (request.method === "GET" && pathname === "/v1/config") {
    return json({
      images: { max_bytes: 8 * 1024 * 1024, max_count: 4, types: ["image/jpeg", "image/png", "image/webp"] },
      password: { min: 10, max_bytes: 256 },
      turnstile_site_key: env.TURNSTILE_SITE_KEY || "",
      username: { min: 3, max: 24, pattern: "[A-Za-z0-9_-]+" },
    });
  }
  if (pathname.startsWith("/v1/auth/")) return handleAuth(request, env, pathname);
  if (request.method === "POST" && pathname === "/v1/uploads") return upload(request, env);

  let match = routeMatch(pathname, /^\/media\/([^/]+)$/);
  if (request.method === "GET" && match) return serveMedia(request, env, match[0]);

  match = routeMatch(pathname, /^\/v1\/articles\/([^/]+)\/comments$/);
  if (match && request.method === "GET") return listComments(request, env, match[0]);
  if (match && request.method === "POST") return createComment(request, env, match[0]);

  match = routeMatch(pathname, /^\/v1\/comments\/([^/]+)$/);
  if (match && request.method === "PATCH") return editComment(request, env, match[0]);
  if (match && request.method === "DELETE") return deleteComment(request, env, match[0]);

  match = routeMatch(pathname, /^\/v1\/mod\/comments\/([^/]+)$/);
  if (match && request.method === "POST") return moderateComment(request, env, match[0]);
  match = routeMatch(pathname, /^\/v1\/mod\/users\/([^/]+)$/);
  if (match && request.method === "POST") return moderateUser(request, env, match[0]);

  return apiError(404, "not_found", "接口不存在。");
}

function isAPIPath(pathname) {
  return pathname === "/healthz" || pathname.startsWith("/v1/") || pathname.startsWith("/media/");
}

function addStaticSecurity(response) {
  const secured = secure(response);
  const headers = new Headers(secured.headers);
  if ((headers.get("Content-Type") || "").includes("text/html")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; " +
      "script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; " +
      "connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self'",
    );
  }
  return new Response(secured.body, { status: secured.status, statusText: secured.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "www.loong0x00.com") {
      url.hostname = "loong0x00.com";
      return secure(Response.redirect(url, 308));
    }
    const { pathname } = url;
    if (request.method === "OPTIONS" && isAPIPath(pathname)) return secure(new Response(null, { status: 204 }));
    if (!isAPIPath(pathname)) {
      if (!env.ASSETS) return secure(apiError(404, "not_found", "页面不存在。"));
      return addStaticSecurity(await env.ASSETS.fetch(request));
    }
    try {
      return secure(await api(request, env));
    } catch (error) {
      if (error instanceof HTTPError) return secure(apiError(error.status, error.code, error.message));
      console.error("field-notes worker error", error);
      return secure(apiError(500, "internal_error", "服务暂时不可用，请稍后再试。"));
    }
  },
};

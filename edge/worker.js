const ORIGIN = "https://loong-field-notes.loong.chatgpt.site";
const PUBLIC_HOST = "loong0x00.com";

export function isBackendPath(pathname) {
  return pathname === "/healthz" || pathname.startsWith("/v1/") || pathname.startsWith("/media/");
}

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function error(status, code, message) {
  return secure(new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  }));
}

function requestOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function proxyBackend(request, env, fetchImpl = fetch) {
  const publicOrigin = requestOrigin(request);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    if (request.headers.get("Origin") !== publicOrigin) {
      return error(403, "origin_not_allowed", "请求来源不被允许。");
    }
  }

  const target = new URL(request.url);
  target.protocol = "https:";
  target.host = new URL(ORIGIN).host;

  const headers = new Headers(request.headers);
  headers.delete("X-Field-Notes-Edge-Secret");
  headers.delete("X-Field-Notes-Client-IP");
  headers.set("Origin", ORIGIN);
  headers.set("X-Forwarded-Host", new URL(request.url).host);
  if (env.ORIGIN_AUTH_SECRET) headers.set("X-Field-Notes-Edge-Secret", env.ORIGIN_AUTH_SECRET);
  const clientIP = request.headers.get("CF-Connecting-IP");
  if (clientIP) headers.set("X-Field-Notes-Client-IP", clientIP);

  const forwarded = new Request(new Request(target, request), {
    headers,
    redirect: "manual",
  });
  try {
    const upstream = await fetchImpl(forwarded);
    return secure(upstream);
  } catch {
    return error(502, "upstream_unavailable", "服务暂时不可用，请稍后再试。");
  }
}

async function staticFallback(request, env) {
  if (!env.ASSETS) return error(404, "not_found", "页面不存在。");
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  const fallbackURL = new URL("/404.html", request.url);
  const fallback = await env.ASSETS.fetch(new Request(fallbackURL));
  if (!fallback.ok) return response;
  return new Response(request.method === "HEAD" ? null : fallback.body, {
    status: 404,
    headers: fallback.headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedPreview = url.hostname.endsWith(".workers.dev") || ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol === "http:" && !allowedPreview) {
      url.protocol = "https:";
      return Response.redirect(url, 308);
    }
    if (url.hostname !== PUBLIC_HOST && !allowedPreview) return error(421, "host_not_allowed", "主机名不受支持。");
    if (isBackendPath(url.pathname)) return proxyBackend(request, env);
    return staticFallback(request, env);
  },
};

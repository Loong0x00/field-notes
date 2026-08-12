import { HTTPError, currentUser, json, nowMilliseconds, randomID, requireUser } from "./utils.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_PIXELS = 40_000_000;

function uint16BE(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32BE(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngInfo(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value) || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { mediaType: "image/png", width: uint32BE(bytes, 16), height: uint32BE(bytes, 20) };
}

function jpegInfo(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = uint16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker) && length >= 7) {
      return { mediaType: "image/jpeg", width: uint16BE(bytes, offset + 5), height: uint16BE(bytes, offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpInfo(bytes) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    return { mediaType: "image/webp", width: uint24LE(bytes, 24) + 1, height: uint24LE(bytes, 27) + 1 };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
    return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { mediaType: "image/webp", width: uint16LE(bytes, 26) & 0x3fff, height: uint16LE(bytes, 28) & 0x3fff };
  }
  return null;
}

export function detectImage(bytes) {
  const info = pngInfo(bytes) || jpegInfo(bytes) || webpInfo(bytes);
  if (!info || info.width < 1 || info.height < 1 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION || info.width * info.height > MAX_PIXELS) {
    throw new HTTPError(415, "unsupported_image", "图片必须是有效的 JPEG、PNG 或 WebP 文件。");
  }
  return info;
}

async function cleanupUnclaimed(env) {
  const cutoff = nowMilliseconds() - 24 * 60 * 60 * 1000;
  const old = await env.DB.prepare(`
    SELECT id, storage_name FROM attachments WHERE comment_id IS NULL AND created_at < ?1 LIMIT 50
  `).bind(cutoff).all();
  const rows = old.results || [];
  if (!rows.length) return;
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${rows.map((_, index) => `?${index + 1}`).join(", ")})`)
    .bind(...rows.map((row) => row.id)).run();
  await Promise.all(rows.map((row) => env.MEDIA.delete(row.storage_name)));
}

export async function upload(request, env) {
  const user = await requireUser(request, env);
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_IMAGE_BYTES + 64 * 1024) throw new HTTPError(413, "image_too_large", "单张图片不能超过 8 MiB。");
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HTTPError(400, "invalid_upload", "上传内容无效。");
  }
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function" || typeof file.size !== "number") {
    throw new HTTPError(400, "invalid_upload", "请选择一张图片。");
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new HTTPError(413, "image_too_large", "单张图片不能超过 8 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = detectImage(bytes);
  const id = randomID();
  const storageName = `attachments/${id}`;
  await env.MEDIA.put(storageName, bytes, {
    httpMetadata: { contentType: info.mediaType, cacheControl: "private, no-store" },
    customMetadata: { uploader: String(user.id) },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO attachments(id, uploader_id, comment_id, storage_name, media_type, byte_size, width, height, created_at)
      VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)
    `).bind(id, user.id, storageName, info.mediaType, bytes.byteLength, info.width, info.height, nowMilliseconds()).run();
  } catch (error) {
    await env.MEDIA.delete(storageName);
    throw error;
  }
  await cleanupUnclaimed(env);
  return json({ attachment: {
    id,
    url: `/media/${id}`,
    media_type: info.mediaType,
    size: bytes.byteLength,
    width: info.width,
    height: info.height,
  } }, 201);
}

export async function serveMedia(request, env, id) {
  const viewer = await currentUser(request, env);
  const row = await env.DB.prepare(`
    SELECT attachments.uploader_id, attachments.comment_id, attachments.storage_name,
           attachments.media_type, comments.deleted_at, comments.hidden_at
    FROM attachments LEFT JOIN comments ON comments.id = attachments.comment_id
    WHERE attachments.id = ?1
  `).bind(id).first();
  if (!row) throw new HTTPError(404, "not_found", "图片不存在。");
  if (row.comment_id === null) {
    if (!viewer || Number(viewer.id) !== Number(row.uploader_id)) throw new HTTPError(404, "not_found", "图片不存在。");
  } else if (row.deleted_at !== null || (row.hidden_at !== null && viewer?.role !== "admin")) {
    throw new HTTPError(404, "not_found", "图片不存在。");
  }
  const object = await env.MEDIA.get(row.storage_name);
  if (!object) throw new HTTPError(404, "not_found", "图片不存在。");
  const headers = new Headers({
    "Content-Type": row.media_type,
    "Content-Length": String(object.size),
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
  });
  return new Response(object.body, { headers });
}

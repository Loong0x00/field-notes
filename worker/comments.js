import {
  HTTPError,
  currentUser,
  json,
  noContent,
  nowMilliseconds,
  randomID,
  readJSON,
  requestIP,
  requireAdmin,
  requireUser,
  takeRateLimit,
} from "./utils.js";

const ARTICLE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function validateArticle(value) {
  if (!ARTICLE_KEY.test(value)) throw new HTTPError(400, "invalid_article", "文章标识无效。");
  return value;
}

function validateComment(input) {
  const body = typeof input.body === "string" ? input.body : "";
  if ([...body].length > 8000) throw new HTTPError(400, "invalid_comment", "正文不能超过 8000 字符。");
  if (CONTROL_CHARACTERS.test(body)) throw new HTTPError(400, "invalid_comment", "正文包含不允许的控制字符。");
  const attachmentIds = input.attachment_ids;
  if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== "string" || !id)) {
    throw new HTTPError(400, "invalid_comment", "图片标识无效。");
  }
  if (attachmentIds.length > 4) throw new HTTPError(400, "invalid_comment", "每条评论最多包含 4 张图片。");
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new HTTPError(400, "invalid_comment", "图片标识重复。");
  }
  if (!body.trim() && attachmentIds.length === 0) {
    throw new HTTPError(400, "invalid_comment", "正文和图片不能同时为空。");
  }
  return { body, attachmentIds };
}

function placeholders(count, start = 1) {
  return Array.from({ length: count }, (_, index) => `?${index + start}`).join(", ");
}

async function loadAttachments(env, ids) {
  if (!ids.length) return [];
  const result = await env.DB.prepare(`
    SELECT id, uploader_id, comment_id, storage_name, media_type, byte_size, width, height
    FROM attachments WHERE id IN (${placeholders(ids.length)})
  `).bind(...ids).all();
  return result.results || [];
}

async function validateAttachments(env, ids, userId, commentId = null) {
  const rows = await loadAttachments(env, ids);
  if (rows.length !== ids.length) throw new HTTPError(400, "invalid_attachment", "图片不存在或已经被使用。");
  for (const row of rows) {
    const belongsToComment = commentId && row.comment_id === commentId;
    if (Number(row.uploader_id) !== Number(userId) || (row.comment_id !== null && !belongsToComment)) {
      throw new HTTPError(400, "invalid_attachment", "图片不存在或已经被使用。");
    }
  }
  return rows;
}

async function removeAttachmentRows(env, rows) {
  if (!rows.length) return;
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders(rows.length)})`)
    .bind(...rows.map((row) => row.id)).run();
  await Promise.all(rows.map((row) => env.MEDIA.delete(row.storage_name)));
}

export async function listComments(request, env, article) {
  validateArticle(article);
  const viewer = await currentUser(request, env);
  const result = await env.DB.prepare(`
    SELECT comments.id, comments.parent_id, comments.body, comments.created_at, comments.updated_at,
           comments.deleted_at, comments.hidden_at,
           users.id AS author_id, users.username, users.role
    FROM comments JOIN users ON users.id = comments.user_id
    WHERE comments.article_key = ?1
    ORDER BY comments.created_at ASC, comments.id ASC
  `).bind(article).all();
  const comments = [];
  const byId = new Map();
  for (const row of result.results || []) {
    const deleted = row.deleted_at !== null;
    const hidden = row.hidden_at !== null;
    const item = {
      id: row.id,
      parent_id: row.parent_id,
      author: { id: Number(row.author_id), username: row.username, role: row.role },
      body: deleted || (hidden && viewer?.role !== "admin") ? "" : row.body,
      created_at: new Date(Number(row.created_at)).toISOString(),
      edited_at: Number(row.updated_at) > Number(row.created_at) ? new Date(Number(row.updated_at)).toISOString() : null,
      deleted,
      hidden,
      attachments: [],
    };
    comments.push(item);
    byId.set(item.id, item);
  }
  if (comments.length) {
    const attachments = await env.DB.prepare(`
      SELECT attachments.id, attachments.comment_id, attachments.media_type,
             attachments.byte_size, attachments.width, attachments.height
      FROM attachments JOIN comments ON comments.id = attachments.comment_id
      WHERE comments.article_key = ?1
      ORDER BY attachments.created_at ASC, attachments.id ASC
    `).bind(article).all();
    for (const row of attachments.results || []) {
      const comment = byId.get(row.comment_id);
      if (!comment || comment.deleted || (comment.hidden && viewer?.role !== "admin")) continue;
      comment.attachments.push({
        id: row.id,
        url: `/media/${row.id}`,
        media_type: row.media_type,
        size: Number(row.byte_size),
        width: Number(row.width),
        height: Number(row.height),
      });
    }
  }
  return json({
    comments,
    viewer: viewer ? { id: Number(viewer.id), username: viewer.username, role: viewer.role } : null,
  });
}

export async function createComment(request, env, article) {
  validateArticle(article);
  const user = await requireUser(request, env);
  const ip = requestIP(request, env);
  if (!await takeRateLimit(env, `comment-user:${user.id}`, 30, 10 * 60) ||
      !await takeRateLimit(env, `comment-ip:${ip}`, 50, 10 * 60)) {
    throw new HTTPError(429, "rate_limited", "发表过于频繁，请稍后再试。");
  }
  const input = await readJSON(request, ["body", "parent_id", "attachment_ids"]);
  const { body, attachmentIds } = validateComment(input);
  const parentId = input.parent_id === null || input.parent_id === undefined ? null : input.parent_id;
  if (parentId !== null && (typeof parentId !== "string" || !parentId)) {
    throw new HTTPError(400, "invalid_parent", "回复目标不存在于这篇文章。");
  }
  if (parentId) {
    const parent = await env.DB.prepare("SELECT article_key FROM comments WHERE id = ?1")
      .bind(parentId).first();
    if (!parent || parent.article_key !== article) {
      throw new HTTPError(400, "invalid_parent", "回复目标不存在于这篇文章。");
    }
  }
  await validateAttachments(env, attachmentIds, user.id);
  const id = randomID();
  const now = nowMilliseconds();
  const statements = [env.DB.prepare(`
    INSERT INTO comments(id, article_key, parent_id, user_id, body, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
  `).bind(id, article, parentId, user.id, body, now)];
  for (const attachmentId of attachmentIds) {
    statements.push(env.DB.prepare(`
      UPDATE attachments SET comment_id = ?1
      WHERE id = ?2 AND uploader_id = ?3 AND comment_id IS NULL
    `).bind(id, attachmentId, user.id));
  }
  await env.DB.batch(statements);
  return json({ id }, 201);
}

export async function editComment(request, env, id) {
  const user = await requireUser(request, env);
  const input = await readJSON(request, ["body", "parent_id", "attachment_ids"]);
  if (input.parent_id !== undefined && input.parent_id !== null) {
    throw new HTTPError(400, "parent_immutable", "不能修改回复层级。");
  }
  const { body, attachmentIds } = validateComment(input);
  const comment = await env.DB.prepare(`
    SELECT user_id, deleted_at, hidden_at FROM comments WHERE id = ?1
  `).bind(id).first();
  if (!comment) throw new HTTPError(404, "comment_not_found", "评论不存在。");
  if (Number(comment.user_id) !== Number(user.id) || comment.deleted_at !== null || comment.hidden_at !== null) {
    throw new HTTPError(403, "comment_not_editable", "不能编辑这条评论。");
  }
  await validateAttachments(env, attachmentIds, user.id, id);
  const oldResult = await env.DB.prepare(`
    SELECT id, storage_name FROM attachments WHERE comment_id = ?1
  `).bind(id).all();
  const keep = new Set(attachmentIds);
  const removed = (oldResult.results || []).filter((row) => !keep.has(row.id));
  const statements = [
    env.DB.prepare("UPDATE comments SET body = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(body, nowMilliseconds(), id),
  ];
  for (const attachmentId of attachmentIds) {
    statements.push(env.DB.prepare(`
      UPDATE attachments SET comment_id = ?1
      WHERE id = ?2 AND uploader_id = ?3 AND (comment_id IS NULL OR comment_id = ?1)
    `).bind(id, attachmentId, user.id));
  }
  await env.DB.batch(statements);
  await removeAttachmentRows(env, removed);
  return noContent();
}

export async function deleteComment(request, env, id) {
  const user = await requireUser(request, env);
  const comment = await env.DB.prepare("SELECT user_id, deleted_at FROM comments WHERE id = ?1").bind(id).first();
  if (!comment) throw new HTTPError(404, "comment_not_found", "评论不存在。");
  if (Number(comment.user_id) !== Number(user.id) || comment.deleted_at !== null) {
    throw new HTTPError(403, "comment_not_deletable", "不能删除这条评论。");
  }
  const attachments = await env.DB.prepare("SELECT id, storage_name FROM attachments WHERE comment_id = ?1")
    .bind(id).all();
  const now = nowMilliseconds();
  await env.DB.prepare("UPDATE comments SET body = '', deleted_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(now, id).run();
  await removeAttachmentRows(env, attachments.results || []);
  return noContent();
}

export async function moderateComment(request, env, id) {
  await requireAdmin(request, env);
  const input = await readJSON(request, ["action"]);
  if (!['hide', 'restore'].includes(input.action)) {
    throw new HTTPError(400, "invalid_action", "管理操作无效。");
  }
  const result = await env.DB.prepare(`
    UPDATE comments SET hidden_at = ?1 WHERE id = ?2 AND deleted_at IS NULL
  `).bind(input.action === "hide" ? nowMilliseconds() : null, id).run();
  if (!result.meta.changes) throw new HTTPError(404, "comment_not_found", "评论不存在。");
  return noContent();
}

export async function moderateUser(request, env, id) {
  const admin = await requireAdmin(request, env);
  const input = await readJSON(request, ["action"]);
  if (input.action !== "ban") throw new HTTPError(400, "invalid_action", "管理操作无效。");
  const userId = Number(id);
  if (!Number.isInteger(userId) || userId <= 0 || userId === Number(admin.id)) {
    throw new HTTPError(400, "invalid_user", "不能管理这个账户。");
  }
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE users SET banned_at = ?1 WHERE id = ?2 AND role != 'admin'")
      .bind(nowMilliseconds(), userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
  ]);
  if (!results[0].meta.changes) throw new HTTPError(404, "user_not_found", "账户不存在。");
  return noContent();
}

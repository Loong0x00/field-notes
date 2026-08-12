import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  usernameNorm: text("username_norm").notNull(),
  passwordHash: text("password_hash").notNull(),
  recoveryHash: text("recovery_hash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: integer("created_at").notNull(),
  bannedAt: integer("banned_at"),
}, (table) => [
  uniqueIndex("idx_users_username_norm").on(table.usernameNorm),
  check("users_role_check", sql`${table.role} IN ('user', 'admin')`),
]);

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("idx_sessions_user_expiry").on(table.userId, table.expiresAt)]);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  articleKey: text("article_key").notNull(),
  parentId: text("parent_id").references((): any => comments.id),
  userId: integer("user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  deletedAt: integer("deleted_at"),
  hiddenAt: integer("hidden_at"),
}, (table) => [
  index("idx_comments_article_created").on(table.articleKey, table.createdAt, table.id),
  index("idx_comments_parent").on(table.parentId),
]);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  uploaderId: integer("uploader_id").notNull().references(() => users.id),
  commentId: text("comment_id").references(() => comments.id, { onDelete: "cascade" }),
  storageName: text("storage_name").notNull(),
  mediaType: text("media_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_attachments_storage_name").on(table.storageName),
  index("idx_attachments_comment").on(table.commentId),
  index("idx_attachments_unclaimed").on(table.createdAt).where(sql`${table.commentId} IS NULL`),
]);

export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  resetAt: integer("reset_at").notNull(),
});

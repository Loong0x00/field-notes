CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`uploader_id` integer NOT NULL,
	`comment_id` text,
	`storage_name` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_attachments_storage_name` ON `attachments` (`storage_name`);--> statement-breakpoint
CREATE INDEX `idx_attachments_comment` ON `attachments` (`comment_id`);--> statement-breakpoint
CREATE INDEX `idx_attachments_unclaimed` ON `attachments` (`created_at`) WHERE "attachments"."comment_id" IS NULL;--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`article_key` text NOT NULL,
	`parent_id` text,
	`user_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`hidden_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_comments_article_created` ON `comments` (`article_key`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_user_expiry` ON `sessions` (`user_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`username_norm` text NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`banned_at` integer,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('user', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username_norm` ON `users` (`username_norm`);--> statement-breakpoint
PRAGMA optimize;

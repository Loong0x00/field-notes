package comments

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type commentInput struct {
	Body          string   `json:"body"`
	ParentID      *string  `json:"parent_id,omitempty"`
	AttachmentIDs []string `json:"attachment_ids"`
}

type AuthorDTO struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type AttachmentDTO struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

type CommentDTO struct {
	ID          string          `json:"id"`
	ParentID    *string         `json:"parent_id"`
	Author      AuthorDTO       `json:"author"`
	Body        string          `json:"body"`
	CreatedAt   string          `json:"created_at"`
	EditedAt    *string         `json:"edited_at"`
	Deleted     bool            `json:"deleted"`
	Hidden      bool            `json:"hidden"`
	Attachments []AttachmentDTO `json:"attachments"`
}

func validateComment(body string, attachmentIDs []string) error {
	if utf8.RuneCountInString(body) > 8000 {
		return errors.New("正文不能超过 8000 字符")
	}
	for _, character := range body {
		if unicode.IsControl(character) && character != '\n' && character != '\r' && character != '\t' {
			return errors.New("正文包含不允许的控制字符")
		}
	}
	if len(attachmentIDs) > 4 {
		return errors.New("每条评论最多包含 4 张图片")
	}
	seen := make(map[string]struct{}, len(attachmentIDs))
	for _, id := range attachmentIDs {
		if id == "" {
			return errors.New("图片标识无效")
		}
		if _, exists := seen[id]; exists {
			return errors.New("图片标识重复")
		}
		seen[id] = struct{}{}
	}
	if strings.TrimSpace(body) == "" && len(attachmentIDs) == 0 {
		return errors.New("正文和图片不能同时为空")
	}
	return nil
}

func (a *App) listComments(w http.ResponseWriter, r *http.Request) {
	article := r.PathValue("article")
	if !articleKeyPattern.MatchString(article) {
		writeError(w, http.StatusBadRequest, "invalid_article", "文章标识无效。")
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT comments.id, comments.parent_id, comments.body,
		       comments.created_at, comments.updated_at, comments.deleted_at, comments.hidden_at,
		       users.id, users.username, users.role
		FROM comments JOIN users ON users.id = comments.user_id
		WHERE comments.article_key = ?1
		ORDER BY comments.created_at ASC, comments.id ASC
	`, article)
	if err != nil {
		a.internalError(w, "list comments", err)
		return
	}
	defer rows.Close()
	comments := make([]CommentDTO, 0)
	index := make(map[string]int)
	viewer := currentUser(r)
	for rows.Next() {
		var item CommentDTO
		var parent sql.NullString
		var createdAt, updatedAt int64
		var deletedAt, hiddenAt sql.NullInt64
		if err := rows.Scan(&item.ID, &parent, &item.Body, &createdAt, &updatedAt, &deletedAt, &hiddenAt,
			&item.Author.ID, &item.Author.Username, &item.Author.Role); err != nil {
			a.internalError(w, "scan comment", err)
			return
		}
		if parent.Valid {
			item.ParentID = &parent.String
		}
		item.CreatedAt = time.UnixMilli(createdAt).UTC().Format(time.RFC3339)
		if updatedAt > createdAt {
			edited := time.UnixMilli(updatedAt).UTC().Format(time.RFC3339)
			item.EditedAt = &edited
		}
		item.Deleted = deletedAt.Valid
		item.Hidden = hiddenAt.Valid
		item.Attachments = make([]AttachmentDTO, 0)
		if item.Deleted || (item.Hidden && (viewer == nil || viewer.Role != "admin")) {
			item.Body = ""
		}
		index[item.ID] = len(comments)
		comments = append(comments, item)
	}
	if err := rows.Err(); err != nil {
		a.internalError(w, "iterate comments", err)
		return
	}
	attachmentRows, err := a.db.QueryContext(r.Context(), `
		SELECT attachments.id, attachments.comment_id, attachments.media_type,
		       attachments.byte_size, attachments.width, attachments.height
		FROM attachments JOIN comments ON comments.id = attachments.comment_id
		WHERE comments.article_key = ?1
		ORDER BY attachments.created_at ASC, attachments.id ASC
	`, article)
	if err != nil {
		a.internalError(w, "list attachments", err)
		return
	}
	defer attachmentRows.Close()
	for attachmentRows.Next() {
		var attachment AttachmentDTO
		var commentID string
		if err := attachmentRows.Scan(&attachment.ID, &commentID, &attachment.MediaType, &attachment.Size, &attachment.Width, &attachment.Height); err != nil {
			a.internalError(w, "scan attachment", err)
			return
		}
		position, exists := index[commentID]
		if !exists || comments[position].Deleted || (comments[position].Hidden && (viewer == nil || viewer.Role != "admin")) {
			continue
		}
		attachment.URL = "/media/" + attachment.ID
		comments[position].Attachments = append(comments[position].Attachments, attachment)
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": comments})
}

func (a *App) createComment(w http.ResponseWriter, r *http.Request) {
	user := requireUser(w, r)
	if user == nil {
		return
	}
	article := r.PathValue("article")
	if !articleKeyPattern.MatchString(article) {
		writeError(w, http.StatusBadRequest, "invalid_article", "文章标识无效。")
		return
	}
	if !a.limiter.allow("comment-user:"+stringID(user.ID), 30, 10*time.Minute) ||
		!a.limiter.allow("comment-ip:"+remoteIP(r), 50, 10*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "发表过于频繁，请稍后再试。")
		return
	}
	var input commentInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := validateComment(input.Body, input.AttachmentIDs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_comment", err.Error()+"。")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internalError(w, "begin create comment", err)
		return
	}
	defer tx.Rollback()
	if input.ParentID != nil {
		var parentArticle string
		if err := tx.QueryRowContext(r.Context(), `SELECT article_key FROM comments WHERE id = ?1`, *input.ParentID).Scan(&parentArticle); err != nil || parentArticle != article {
			writeError(w, http.StatusBadRequest, "invalid_parent", "回复目标不存在于这篇文章。")
			return
		}
	}
	if err := validateAttachments(r.Context(), tx, input.AttachmentIDs, user.ID, ""); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_attachment", err.Error()+"。")
		return
	}
	_, commentID, err := randomToken(18)
	if err != nil {
		a.internalError(w, "create comment id", err)
		return
	}
	now := time.Now().UnixMilli()
	var parent any
	if input.ParentID != nil {
		parent = *input.ParentID
	}
	if _, err = tx.ExecContext(r.Context(), `
		INSERT INTO comments(id, article_key, parent_id, user_id, body, created_at, updated_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
	`, commentID, article, parent, user.ID, input.Body, now); err != nil {
		a.internalError(w, "insert comment", err)
		return
	}
	if err := claimAttachments(r.Context(), tx, input.AttachmentIDs, user.ID, commentID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_attachment", err.Error()+"。")
		return
	}
	if err := tx.Commit(); err != nil {
		a.internalError(w, "commit comment", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": commentID})
}

func (a *App) editComment(w http.ResponseWriter, r *http.Request) {
	user := requireUser(w, r)
	if user == nil {
		return
	}
	commentID := r.PathValue("id")
	var input commentInput
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.ParentID != nil {
		writeError(w, http.StatusBadRequest, "parent_immutable", "不能修改回复层级。")
		return
	}
	if err := validateComment(input.Body, input.AttachmentIDs); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_comment", err.Error()+"。")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internalError(w, "begin edit comment", err)
		return
	}
	defer tx.Rollback()
	var ownerID int64
	var deletedAt, hiddenAt sql.NullInt64
	if err := tx.QueryRowContext(r.Context(), `SELECT user_id, deleted_at, hidden_at FROM comments WHERE id = ?1`, commentID).Scan(&ownerID, &deletedAt, &hiddenAt); err != nil {
		writeError(w, http.StatusNotFound, "comment_not_found", "评论不存在。")
		return
	}
	if ownerID != user.ID || deletedAt.Valid || hiddenAt.Valid {
		writeError(w, http.StatusForbidden, "comment_not_editable", "不能编辑这条评论。")
		return
	}
	if err := validateAttachments(r.Context(), tx, input.AttachmentIDs, user.ID, commentID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_attachment", err.Error()+"。")
		return
	}
	removed, err := attachmentFilesNotIn(r.Context(), tx, commentID, input.AttachmentIDs)
	if err != nil {
		a.internalError(w, "find removed attachments", err)
		return
	}
	if _, err = tx.ExecContext(r.Context(), `UPDATE comments SET body = ?1, updated_at = ?2 WHERE id = ?3`, input.Body, time.Now().UnixMilli(), commentID); err == nil {
		err = deleteAttachmentsNotIn(r.Context(), tx, commentID, input.AttachmentIDs)
	}
	if err == nil {
		err = claimAttachments(r.Context(), tx, input.AttachmentIDs, user.ID, commentID)
	}
	if err != nil {
		a.internalError(w, "edit attachments", err)
		return
	}
	if err := tx.Commit(); err != nil {
		a.internalError(w, "commit edit", err)
		return
	}
	for _, name := range removed {
		_ = os.Remove(a.mediaPath(name))
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) deleteComment(w http.ResponseWriter, r *http.Request) {
	user := requireUser(w, r)
	if user == nil {
		return
	}
	commentID := r.PathValue("id")
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internalError(w, "begin delete comment", err)
		return
	}
	defer tx.Rollback()
	var ownerID int64
	if err := tx.QueryRowContext(r.Context(), `SELECT user_id FROM comments WHERE id = ?1 AND deleted_at IS NULL`, commentID).Scan(&ownerID); err != nil {
		writeError(w, http.StatusNotFound, "comment_not_found", "评论不存在。")
		return
	}
	if ownerID != user.ID && user.Role != "admin" {
		writeError(w, http.StatusForbidden, "comment_not_owned", "不能删除这条评论。")
		return
	}
	files, err := attachmentFilesNotIn(r.Context(), tx, commentID, nil)
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM attachments WHERE comment_id = ?1`, commentID)
	}
	if err == nil {
		_, err = tx.ExecContext(r.Context(), `UPDATE comments SET body = '', deleted_at = ?1, updated_at = ?1 WHERE id = ?2`, time.Now().UnixMilli(), commentID)
	}
	if err != nil {
		a.internalError(w, "delete comment", err)
		return
	}
	if err := tx.Commit(); err != nil {
		a.internalError(w, "commit delete", err)
		return
	}
	for _, name := range files {
		_ = os.Remove(a.mediaPath(name))
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) moderateComment(w http.ResponseWriter, r *http.Request) {
	if requireAdmin(w, r) == nil {
		return
	}
	var input struct {
		Action string `json:"action"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	var result sql.Result
	var err error
	switch input.Action {
	case "hide":
		result, err = a.db.ExecContext(r.Context(), `UPDATE comments SET hidden_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`, time.Now().UnixMilli(), r.PathValue("id"))
	case "restore":
		result, err = a.db.ExecContext(r.Context(), `UPDATE comments SET hidden_at = NULL WHERE id = ?1 AND deleted_at IS NULL`, r.PathValue("id"))
	default:
		writeError(w, http.StatusBadRequest, "invalid_action", "管理操作无效。")
		return
	}
	if err != nil {
		a.internalError(w, "moderate comment", err)
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeError(w, http.StatusNotFound, "comment_not_found", "评论不存在。")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) moderateUser(w http.ResponseWriter, r *http.Request) {
	admin := requireAdmin(w, r)
	if admin == nil {
		return
	}
	userID, err := userIDFromPath(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_user", "账户标识无效。")
		return
	}
	if userID == admin.ID {
		writeError(w, http.StatusBadRequest, "cannot_ban_self", "不能封禁自己的账户。")
		return
	}
	var input struct {
		Action string `json:"action"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internalError(w, "begin moderate user", err)
		return
	}
	defer tx.Rollback()
	var result sql.Result
	switch input.Action {
	case "ban":
		result, err = tx.ExecContext(r.Context(), `UPDATE users SET banned_at = ?1 WHERE id = ?2 AND role != 'admin'`, time.Now().Unix(), userID)
	case "unban":
		result, err = tx.ExecContext(r.Context(), `UPDATE users SET banned_at = NULL WHERE id = ?1 AND role != 'admin'`, userID)
	default:
		writeError(w, http.StatusBadRequest, "invalid_action", "管理操作无效。")
		return
	}
	if err == nil && input.Action == "ban" {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM sessions WHERE user_id = ?1`, userID)
	}
	if err != nil {
		a.internalError(w, "moderate user", err)
		return
	}
	if count, _ := result.RowsAffected(); count == 0 {
		writeError(w, http.StatusNotFound, "user_not_found", "账户不存在或不可管理。")
		return
	}
	if err := tx.Commit(); err != nil {
		a.internalError(w, "commit moderate user", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validateAttachments(ctx context.Context, tx *sql.Tx, ids []string, userID int64, commentID string) error {
	for _, id := range ids {
		var uploaderID int64
		var attached sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT uploader_id, comment_id FROM attachments WHERE id = ?1`, id).Scan(&uploaderID, &attached); err != nil {
			return errors.New("图片不存在或已经失效")
		}
		if uploaderID != userID || (attached.Valid && attached.String != commentID) {
			return errors.New("图片不属于当前账户或已被使用")
		}
	}
	return nil
}

func claimAttachments(ctx context.Context, tx *sql.Tx, ids []string, userID int64, commentID string) error {
	for _, id := range ids {
		result, err := tx.ExecContext(ctx, `
			UPDATE attachments SET comment_id = ?1
			WHERE id = ?2 AND uploader_id = ?3 AND (comment_id IS NULL OR comment_id = ?1)
		`, commentID, id, userID)
		if err != nil {
			return err
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return errors.New("图片无法关联到评论")
		}
	}
	return nil
}

func attachmentFilesNotIn(ctx context.Context, tx *sql.Tx, commentID string, keep []string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, storage_name FROM attachments WHERE comment_id = ?1`, commentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	wanted := make(map[string]struct{}, len(keep))
	for _, id := range keep {
		wanted[id] = struct{}{}
	}
	var names []string
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		if _, exists := wanted[id]; !exists {
			names = append(names, name)
		}
	}
	return names, rows.Err()
}

func deleteAttachmentsNotIn(ctx context.Context, tx *sql.Tx, commentID string, keep []string) error {
	if len(keep) == 0 {
		_, err := tx.ExecContext(ctx, `DELETE FROM attachments WHERE comment_id = ?1`, commentID)
		return err
	}
	query := `DELETE FROM attachments WHERE comment_id = ?1 AND id NOT IN (`
	args := make([]any, 0, len(keep)+1)
	args = append(args, commentID)
	for index, id := range keep {
		if index > 0 {
			query += ","
		}
		query += "?" + stringID(int64(index+2))
		args = append(args, id)
	}
	query += ")"
	_, err := tx.ExecContext(ctx, query, args...)
	return err
}

func stringID(value int64) string {
	return strconv.FormatInt(value, 10)
}

package comments

import (
	"bytes"
	"database/sql"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	_ "golang.org/x/image/webp"
)

const (
	maxUploadBytes = 8 << 20
	maxStoredBytes = 16 << 20
	maxImagePixels = 32_000_000
)

func (a *App) upload(w http.ResponseWriter, r *http.Request) {
	user := requireUser(w, r)
	if user == nil {
		return
	}
	if !a.limiter.allow("upload-user:"+stringID(user.ID), 20, 10*time.Minute) ||
		!a.limiter.allow("upload-ip:"+remoteIP(r), 30, 10*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "图片上传过于频繁，请稍后再试。")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+(256<<10))
	if err := r.ParseMultipartForm(maxUploadBytes + (128 << 10)); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_upload", "上传内容无效或超过 8 MiB。")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file_required", "请选择一张图片。")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxUploadBytes {
		writeError(w, http.StatusBadRequest, "invalid_upload", "图片为空或超过 8 MiB。")
		return
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_image", "只允许真实的 JPEG、PNG 或 WebP 图片。")
		return
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > maxImagePixels {
		writeError(w, http.StatusBadRequest, "image_too_large", "图片像素尺寸过大。")
		return
	}
	decoded, decodedFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || decodedFormat != format {
		writeError(w, http.StatusBadRequest, "invalid_image", "图片无法完整解码。")
		return
	}
	var normalized bytes.Buffer
	mediaType, extension := "image/png", ".png"
	if format == "jpeg" {
		mediaType, extension = "image/jpeg", ".jpg"
		err = jpeg.Encode(&normalized, decoded, &jpeg.Options{Quality: 92})
	} else {
		err = png.Encode(&normalized, decoded)
	}
	if err != nil || normalized.Len() == 0 || normalized.Len() > maxStoredBytes {
		writeError(w, http.StatusBadRequest, "image_normalization_failed", "图片规范化后过大或无法保存。")
		return
	}
	_, attachmentID, err := randomToken(18)
	if err != nil {
		a.internalError(w, "create attachment id", err)
		return
	}
	_, storageID, err := randomToken(24)
	if err != nil {
		a.internalError(w, "create storage id", err)
		return
	}
	storageName := storageID + extension
	if err := a.writeMediaAtomically(storageName, normalized.Bytes()); err != nil {
		a.internalError(w, "store media", err)
		return
	}
	_, err = a.db.ExecContext(r.Context(), `
		INSERT INTO attachments(id, uploader_id, storage_name, media_type, byte_size, width, height, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
	`, attachmentID, user.ID, storageName, mediaType, normalized.Len(), config.Width, config.Height, time.Now().Unix())
	if err != nil {
		_ = os.Remove(a.mediaPath(storageName))
		a.internalError(w, "record media", err)
		return
	}
	go a.cleanupUnclaimedUploads()
	writeJSON(w, http.StatusCreated, map[string]any{"attachment": AttachmentDTO{
		ID: attachmentID, URL: "/media/" + attachmentID, MediaType: mediaType,
		Size: int64(normalized.Len()), Width: config.Width, Height: config.Height,
	}})
}

func (a *App) serveMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var storageName, mediaType string
	var uploaderID int64
	var commentID sql.NullString
	var hiddenAt, deletedAt sql.NullInt64
	err := a.db.QueryRowContext(r.Context(), `
		SELECT attachments.storage_name, attachments.media_type, attachments.uploader_id,
		       attachments.comment_id, comments.hidden_at, comments.deleted_at
		FROM attachments LEFT JOIN comments ON comments.id = attachments.comment_id
		WHERE attachments.id = ?1
	`, id).Scan(&storageName, &mediaType, &uploaderID, &commentID, &hiddenAt, &deletedAt)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	viewer := currentUser(r)
	if !commentID.Valid {
		if viewer == nil || viewer.ID != uploaderID {
			http.NotFound(w, r)
			return
		}
	} else if deletedAt.Valid || (hiddenAt.Valid && (viewer == nil || viewer.Role != "admin")) {
		http.NotFound(w, r)
		return
	}
	// A moderator must be able to revoke an image immediately. Long-lived public
	// caches would keep serving media after the owning comment is hidden/deleted.
	w.Header().Set("Cache-Control", "private, no-store")
	path := a.mediaPath(storageName)
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Disposition", `inline; filename="image`+filepath.Ext(storageName)+`"`)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	http.ServeContent(w, r, storageName, info.ModTime(), file)
}

func (a *App) mediaPath(storageName string) string {
	if filepath.Base(storageName) != storageName {
		return filepath.Join(a.mediaDir, "invalid")
	}
	return filepath.Join(a.mediaDir, storageName)
}

func (a *App) writeMediaAtomically(storageName string, data []byte) error {
	temp, err := os.CreateTemp(a.mediaDir, ".upload-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, a.mediaPath(storageName))
}

func (a *App) cleanupUnclaimedUploads() {
	cutoff := time.Now().Add(-24 * time.Hour).Unix()
	rows, err := a.db.Query(`SELECT id, storage_name FROM attachments WHERE comment_id IS NULL AND created_at < ?1`, cutoff)
	if err != nil {
		return
	}
	type stale struct{ id, name string }
	var items []stale
	for rows.Next() {
		var item stale
		if rows.Scan(&item.id, &item.name) == nil {
			items = append(items, item)
		}
	}
	rows.Close()
	for _, item := range items {
		result, err := a.db.Exec(`DELETE FROM attachments WHERE id = ?1 AND comment_id IS NULL`, item.id)
		if err != nil {
			continue
		}
		if count, _ := result.RowsAffected(); count == 1 {
			_ = os.Remove(a.mediaPath(item.name))
		}
	}
}

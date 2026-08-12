package comments

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	argonMemory      = 19 * 1024
	argonIterations  = 2
	argonParallelism = 1
	argonKeyLength   = 32
	sessionLifetime  = 30 * 24 * time.Hour
)

var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{3,24}$`)

type turnstileVerifier interface {
	verify(context.Context, string, string) bool
}

type cloudflareTurnstile struct {
	secret   string
	disabled bool
}

func (v *cloudflareTurnstile) verify(ctx context.Context, token, ip string) bool {
	if v.disabled {
		return true
	}
	if token == "" {
		return false
	}
	form := url.Values{"secret": {v.secret}, "response": {token}}
	if ip != "" {
		form.Set("remoteip", ip)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(form.Encode()))
	if err != nil {
		return false
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var result struct {
		Success bool `json:"success"`
	}
	return response.StatusCode == http.StatusOK && json.NewDecoder(response.Body).Decode(&result) == nil && result.Success
}

type authRequest struct {
	Username       string `json:"username"`
	Password       string `json:"password"`
	RecoveryCode   string `json:"recovery_code,omitempty"`
	TurnstileToken string `json:"turnstile_token"`
}

func normalizeUsername(username string) (string, string, error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", "", errors.New("用户名必须为 3–24 位，只能包含英文字母、数字、下划线和连字符")
	}
	return username, strings.ToLower(username), nil
}

func validatePassword(password string) error {
	if utf8.RuneCountInString(password) < 10 {
		return errors.New("密码至少需要 10 个字符")
	}
	if len(password) > 256 {
		return errors.New("密码不能超过 256 字节")
	}
	return nil
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var memory uint32
	var iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false
	}
	if memory < 8*1024 || memory > 256*1024 || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 8 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 16 {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) != argonKeyLength {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

func newRecoveryCode() (display string, hash []byte, err error) {
	raw := make([]byte, 20)
	if _, err = rand.Read(raw); err != nil {
		return "", nil, err
	}
	plain := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	groups := make([]string, 0, len(plain)/4)
	for len(plain) > 0 {
		size := 4
		if len(plain) < size {
			size = len(plain)
		}
		groups = append(groups, plain[:size])
		plain = plain[size:]
	}
	display = strings.Join(groups, "-")
	sum := sha256.Sum256([]byte(normalizeRecoveryCode(display)))
	return display, sum[:], nil
}

func normalizeRecoveryCode(code string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), "-", ""))
}

func recoveryMatches(stored []byte, supplied string) bool {
	sum := sha256.Sum256([]byte(normalizeRecoveryCode(supplied)))
	return len(stored) == len(sum) && subtle.ConstantTimeCompare(stored, sum[:]) == 1
}

func (a *App) session(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"user": currentUser(r)})
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	ip := remoteIP(r)
	if !a.limiter.allow("register:"+ip, 5, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "注册过于频繁，请稍后再试。")
		return
	}
	var input authRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	username, usernameNorm, err := normalizeUsername(input.Username)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_username", err.Error()+"。")
		return
	}
	if err := validatePassword(input.Password); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_password", err.Error()+"。")
		return
	}
	if !a.turnstile.verify(r.Context(), input.TurnstileToken, ip) {
		writeError(w, http.StatusBadRequest, "turnstile_failed", "人机验证失败，请重试。")
		return
	}
	passwordHash, err := hashPassword(input.Password)
	if err != nil {
		a.internalError(w, "hash password", err)
		return
	}
	recoveryCode, recoveryHash, err := newRecoveryCode()
	if err != nil {
		a.internalError(w, "create recovery code", err)
		return
	}
	result, err := a.db.ExecContext(r.Context(), `
		INSERT INTO users(username, username_norm, password_hash, recovery_hash, created_at)
		VALUES (?1, ?2, ?3, ?4, ?5)
	`, username, usernameNorm, passwordHash, recoveryHash, time.Now().Unix())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeError(w, http.StatusConflict, "username_unavailable", "这个用户名不可用。")
			return
		}
		a.internalError(w, "create user", err)
		return
	}
	userID, _ := result.LastInsertId()
	user := &User{ID: userID, Username: username, Role: "user"}
	if err := a.createSession(r.Context(), w, user.ID); err != nil {
		a.internalError(w, "create session", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": user, "recovery_code": recoveryCode})
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	_, usernameNorm, err := normalizeUsername(input.Username)
	if err != nil {
		usernameNorm = strings.ToLower(strings.TrimSpace(input.Username))
	}
	ip := remoteIP(r)
	key := "login:" + ip + ":" + usernameNorm
	if !a.limiter.allow("login-all:"+ip, 30, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "登录尝试过于频繁，请稍后再试。")
		return
	}
	if a.limiter.count(key, 15*time.Minute) >= 5 && !a.turnstile.verify(r.Context(), input.TurnstileToken, ip) {
		writeError(w, http.StatusBadRequest, "turnstile_required", "请先完成人机验证。")
		return
	}
	var user User
	var passwordHash string
	var bannedAt sql.NullInt64
	err = a.db.QueryRowContext(r.Context(), `
		SELECT id, username, role, password_hash, banned_at FROM users WHERE username_norm = ?1
	`, usernameNorm).Scan(&user.ID, &user.Username, &user.Role, &passwordHash, &bannedAt)
	if err != nil || bannedAt.Valid || !verifyPassword(passwordHash, input.Password) {
		a.limiter.allow(key, 1<<30, 15*time.Minute)
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "用户名或密码错误。")
		return
	}
	a.limiter.reset(key)
	if err := a.createSession(r.Context(), w, user.ID); err != nil {
		a.internalError(w, "create session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": &user})
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(a.cookieName); err == nil && cookie.Value != "" {
		hash := sha256.Sum256([]byte(cookie.Value))
		_, _ = a.db.ExecContext(r.Context(), "DELETE FROM sessions WHERE token_hash = ?1", hash[:])
	}
	a.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) recover(w http.ResponseWriter, r *http.Request) {
	ip := remoteIP(r)
	if !a.limiter.allow("recover:"+ip, 8, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "恢复尝试过于频繁，请稍后再试。")
		return
	}
	var input authRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	_, usernameNorm, _ := normalizeUsername(input.Username)
	if err := validatePassword(input.Password); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_password", err.Error()+"。")
		return
	}
	if !a.turnstile.verify(r.Context(), input.TurnstileToken, ip) {
		writeError(w, http.StatusBadRequest, "turnstile_failed", "人机验证失败，请重试。")
		return
	}
	var user User
	var recoveryHash []byte
	err := a.db.QueryRowContext(r.Context(), `
		SELECT id, username, role, recovery_hash FROM users WHERE username_norm = ?1 AND banned_at IS NULL
	`, usernameNorm).Scan(&user.ID, &user.Username, &user.Role, &recoveryHash)
	if err != nil || !recoveryMatches(recoveryHash, input.RecoveryCode) {
		writeError(w, http.StatusUnauthorized, "invalid_recovery", "用户名或恢复信息无效。")
		return
	}
	passwordHash, err := hashPassword(input.Password)
	if err != nil {
		a.internalError(w, "hash recovered password", err)
		return
	}
	newCode, newHash, err := newRecoveryCode()
	if err != nil {
		a.internalError(w, "rotate recovery code", err)
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		a.internalError(w, "begin recovery", err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(r.Context(), `UPDATE users SET password_hash = ?1, recovery_hash = ?2 WHERE id = ?3`, passwordHash, newHash, user.ID); err == nil {
		_, err = tx.ExecContext(r.Context(), `DELETE FROM sessions WHERE user_id = ?1`, user.ID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		a.internalError(w, "commit recovery", err)
		return
	}
	if err := a.createSession(r.Context(), w, user.ID); err != nil {
		a.internalError(w, "create recovered session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": &user, "recovery_code": newCode})
}

func (a *App) createSession(ctx context.Context, w http.ResponseWriter, userID int64) error {
	raw, _, err := randomToken(32)
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte(raw))
	now := time.Now()
	if _, err := a.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?1`, now.Unix()); err != nil {
		return err
	}
	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)
	`, hash[:], userID, now.Unix(), now.Add(sessionLifetime).Unix()); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName,
		Value:    raw,
		Path:     "/",
		MaxAge:   int(sessionLifetime.Seconds()),
		Expires:  now.Add(sessionLifetime),
		HttpOnly: true,
		Secure:   a.secure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (a *App) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     a.cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
		HttpOnly: true,
		Secure:   a.secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (a *App) BootstrapAdmin(ctx context.Context, username, password string) (string, error) {
	username, usernameNorm, err := normalizeUsername(username)
	if err != nil {
		return "", err
	}
	if err := validatePassword(password); err != nil {
		return "", err
	}
	passwordHash, err := hashPassword(password)
	if err != nil {
		return "", err
	}
	recoveryCode, recoveryHash, err := newRecoveryCode()
	if err != nil {
		return "", err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `
		INSERT INTO users(username, username_norm, password_hash, recovery_hash, role, created_at)
		VALUES (?1, ?2, ?3, ?4, 'admin', ?5)
		ON CONFLICT(username_norm) DO UPDATE SET
		  username = excluded.username,
		  password_hash = excluded.password_hash,
		  recovery_hash = excluded.recovery_hash,
		  role = 'admin',
		  banned_at = NULL
	`, username, usernameNorm, passwordHash, recoveryHash, time.Now().Unix())
	if err != nil {
		return "", err
	}
	var userID int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE username_norm = ?1`, usernameNorm).Scan(&userID); err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?1`, userID); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return recoveryCode, nil
}

func (a *App) internalError(w http.ResponseWriter, operation string, err error) {
	if err == nil {
		err = errors.New("unknown error")
	}
	a.logger.Error(operation, "error", err)
	writeError(w, http.StatusInternalServerError, "internal_error", "服务器内部错误。")
}

func userIDFromPath(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.PathValue("id"), 10, 64)
}

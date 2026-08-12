package comments

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed schema.sql
var schemaSQL string

var articleKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,79}$`)

type Config struct {
	DatabasePath       string
	MediaDir           string
	AllowedOrigins     []string
	CookieName         string
	SecureCookies      bool
	TurnstileSiteKey   string
	TurnstileSecretKey string
	AllowNoTurnstile   bool
	Logger             *slog.Logger
}

type App struct {
	db         *sql.DB
	mediaDir   string
	origins    map[string]struct{}
	cookieName string
	secure     bool
	siteKey    string
	turnstile  turnstileVerifier
	logger     *slog.Logger
	limiter    *memoryLimiter
	mux        *http.ServeMux
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

type contextKey string

const userContextKey contextKey = "user"

func Open(config Config) (*App, error) {
	if config.DatabasePath == "" || config.MediaDir == "" {
		return nil, errors.New("database path and media directory are required")
	}
	if len(config.AllowedOrigins) == 0 {
		return nil, errors.New("at least one allowed origin is required")
	}
	if config.CookieName == "" {
		config.CookieName = "field_notes_session"
	}
	if !config.AllowNoTurnstile && (config.TurnstileSiteKey == "" || config.TurnstileSecretKey == "") {
		return nil, errors.New("Turnstile site and secret keys are required")
	}
	if config.Logger == nil {
		config.Logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	if err := os.MkdirAll(filepath.Dir(config.DatabasePath), 0700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	if err := os.MkdirAll(config.MediaDir, 0700); err != nil {
		return nil, fmt.Errorf("create media directory: %w", err)
	}
	if err := os.Chmod(config.MediaDir, 0700); err != nil {
		return nil, fmt.Errorf("secure media directory: %w", err)
	}
	databaseFile, err := os.OpenFile(config.DatabasePath, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return nil, fmt.Errorf("create database file: %w", err)
	}
	if err := databaseFile.Close(); err != nil {
		return nil, fmt.Errorf("close database file: %w", err)
	}
	if err := os.Chmod(config.DatabasePath, 0600); err != nil {
		return nil, fmt.Errorf("secure database file: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_busy_timeout=5000&_foreign_keys=on&_journal_mode=WAL", config.DatabasePath)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	origins := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		origin = strings.TrimSpace(strings.TrimSuffix(origin, "/"))
		if origin != "" {
			origins[origin] = struct{}{}
		}
	}
	app := &App{
		db:         db,
		mediaDir:   config.MediaDir,
		origins:    origins,
		cookieName: config.CookieName,
		secure:     config.SecureCookies,
		siteKey:    config.TurnstileSiteKey,
		turnstile:  &cloudflareTurnstile{secret: config.TurnstileSecretKey, disabled: config.AllowNoTurnstile},
		logger:     config.Logger,
		limiter:    newMemoryLimiter(),
		mux:        http.NewServeMux(),
	}
	app.routes()
	return app, nil
}

func (a *App) Close() error { return a.db.Close() }

func (a *App) Handler() http.Handler {
	return a.securityAndCORS(a.authenticate(a.mux))
}

func (a *App) routes() {
	a.mux.HandleFunc("GET /healthz", a.health)
	a.mux.HandleFunc("GET /v1/config", a.config)
	a.mux.HandleFunc("GET /v1/auth/session", a.session)
	a.mux.HandleFunc("POST /v1/auth/register", a.register)
	a.mux.HandleFunc("POST /v1/auth/login", a.login)
	a.mux.HandleFunc("POST /v1/auth/logout", a.logout)
	a.mux.HandleFunc("POST /v1/auth/recover", a.recover)
	a.mux.HandleFunc("POST /v1/uploads", a.upload)
	a.mux.HandleFunc("GET /media/{id}", a.serveMedia)
	a.mux.HandleFunc("GET /v1/articles/{article}/comments", a.listComments)
	a.mux.HandleFunc("POST /v1/articles/{article}/comments", a.createComment)
	a.mux.HandleFunc("PATCH /v1/comments/{id}", a.editComment)
	a.mux.HandleFunc("DELETE /v1/comments/{id}", a.deleteComment)
	a.mux.HandleFunc("POST /v1/mod/comments/{id}", a.moderateComment)
	a.mux.HandleFunc("POST /v1/mod/users/{id}", a.moderateUser)
}

func (a *App) securityAndCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		origin := strings.TrimSuffix(r.Header.Get("Origin"), "/")
		_, allowed := a.origins[origin]
		if origin != "" && !allowed {
			writeError(w, http.StatusForbidden, "origin_not_allowed", "请求来源不被允许。")
			return
		}
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if isUnsafeMethod(r.Method) && origin != "" && !allowed {
			writeError(w, http.StatusForbidden, "origin_not_allowed", "请求来源不被允许。")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet && method != http.MethodHead && method != http.MethodOptions
}

func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(a.cookieName)
		if err != nil || cookie.Value == "" {
			next.ServeHTTP(w, r)
			return
		}
		hash := sha256.Sum256([]byte(cookie.Value))
		var user User
		err = a.db.QueryRowContext(r.Context(), `
			SELECT users.id, users.username, users.role
			FROM sessions JOIN users ON users.id = sessions.user_id
			WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2 AND users.banned_at IS NULL
		`, hash[:], time.Now().Unix()).Scan(&user.ID, &user.Username, &user.Role)
		if err == nil {
			r = r.WithContext(context.WithValue(r.Context(), userContextKey, &user))
		} else if !errors.Is(err, sql.ErrNoRows) {
			a.logger.Error("session lookup failed", "error", err)
		}
		next.ServeHTTP(w, r)
	})
}

func currentUser(r *http.Request) *User {
	user, _ := r.Context().Value(userContextKey).(*User)
	return user
}

func requireUser(w http.ResponseWriter, r *http.Request) *User {
	user := currentUser(r)
	if user == nil {
		writeError(w, http.StatusUnauthorized, "authentication_required", "请先登录。")
	}
	return user
}

func requireAdmin(w http.ResponseWriter, r *http.Request) *User {
	user := requireUser(w, r)
	if user != nil && user.Role != "admin" {
		writeError(w, http.StatusForbidden, "admin_required", "需要站点管理员权限。")
		return nil
	}
	return user
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	if err := a.db.PingContext(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable", "数据库不可用。")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *App) config(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"turnstile_site_key": a.siteKey,
		"username":           map[string]any{"min": 3, "max": 24, "pattern": "[A-Za-z0-9_-]+"},
		"password":           map[string]any{"min": 10, "max_bytes": 256},
		"images":             map[string]any{"max_count": 4, "max_bytes": 8 << 20, "types": []string{"image/jpeg", "image/png", "image/webp"}},
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "json_required", "请求必须使用 JSON。")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求内容无效。")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_json", "请求只能包含一个 JSON 对象。")
		return false
	}
	return true
}

func randomToken(bytes int) (raw, id string, err error) {
	data := make([]byte, bytes)
	if _, err = rand.Read(data); err != nil {
		return "", "", err
	}
	raw = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(data)
	sum := sha256.Sum256(data)
	id = hex.EncodeToString(sum[:12])
	return raw, id, nil
}

func remoteIP(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); value != "" {
		return value
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

type memoryLimiter struct {
	mu      sync.Mutex
	buckets map[string]*limitBucket
}

type limitBucket struct {
	start time.Time
	count int
}

func newMemoryLimiter() *memoryLimiter {
	return &memoryLimiter{buckets: make(map[string]*limitBucket)}
}

func (l *memoryLimiter) allow(key string, max int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	bucket := l.buckets[key]
	if bucket == nil || now.Sub(bucket.start) >= window {
		l.buckets[key] = &limitBucket{start: now, count: 1}
		return true
	}
	if bucket.count >= max {
		return false
	}
	bucket.count++
	return true
}

func (l *memoryLimiter) count(key string, window time.Duration) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	bucket := l.buckets[key]
	if bucket == nil || time.Since(bucket.start) >= window {
		return 0
	}
	return bucket.count
}

func (l *memoryLimiter) reset(key string) {
	l.mu.Lock()
	delete(l.buckets, key)
	l.mu.Unlock()
}

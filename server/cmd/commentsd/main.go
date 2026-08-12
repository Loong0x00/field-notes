package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	comments "github.com/Loong0x00/field-notes/comments"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
	}
	if command != "serve" && command != "bootstrap-admin" {
		return fmt.Errorf("usage: commentsd [serve|bootstrap-admin]")
	}

	config, listen, err := configFromEnv(command == "serve")
	if err != nil {
		return err
	}
	app, err := comments.Open(config)
	if err != nil {
		return err
	}
	defer app.Close()

	if command == "bootstrap-admin" {
		username := os.Getenv("COMMENTS_ADMIN_USERNAME")
		password := os.Getenv("COMMENTS_ADMIN_PASSWORD")
		if username == "" || password == "" {
			return errors.New("COMMENTS_ADMIN_USERNAME and COMMENTS_ADMIN_PASSWORD are required")
		}
		recoveryCode, err := app.BootstrapAdmin(context.Background(), username, password)
		if err != nil {
			return err
		}
		fmt.Println(recoveryCode)
		return nil
	}

	server := &http.Server{
		Addr:              listen,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	config.Logger.Info("comment service listening", "address", listen)
	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func configFromEnv(serving bool) (comments.Config, string, error) {
	dataDir := envOr("COMMENTS_DATA_DIR", "./data")
	allowed := splitCSV(os.Getenv("COMMENTS_ALLOWED_ORIGINS"))
	if len(allowed) == 0 {
		return comments.Config{}, "", errors.New("COMMENTS_ALLOWED_ORIGINS is required")
	}
	allowNoTurnstile, err := boolEnv("COMMENTS_ALLOW_NO_TURNSTILE", false)
	if err != nil {
		return comments.Config{}, "", err
	}
	secureCookies, err := boolEnv("COMMENTS_SECURE_COOKIE", true)
	if err != nil {
		return comments.Config{}, "", err
	}
	if !serving {
		allowNoTurnstile = true
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return comments.Config{
		DatabasePath:       filepath.Join(dataDir, "comments.sqlite"),
		MediaDir:           filepath.Join(dataDir, "media"),
		AllowedOrigins:     allowed,
		CookieName:         envOr("COMMENTS_COOKIE_NAME", "field_notes_session"),
		SecureCookies:      secureCookies,
		TurnstileSiteKey:   os.Getenv("TURNSTILE_SITE_KEY"),
		TurnstileSecretKey: os.Getenv("TURNSTILE_SECRET_KEY"),
		AllowNoTurnstile:   allowNoTurnstile,
		Logger:             logger,
	}, envOr("COMMENTS_LISTEN", "127.0.0.1:8090"), nil
}

func splitCSV(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, strings.TrimSuffix(item, "/"))
		}
	}
	return result
}

func boolEnv(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", name, err)
	}
	return parsed, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

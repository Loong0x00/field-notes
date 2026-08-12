package comments

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testOrigin = "https://loong0x00.com"

type testAPI struct {
	t      *testing.T
	app    *App
	server *httptest.Server
}

func newTestAPI(t *testing.T) *testAPI {
	t.Helper()
	dir := t.TempDir()
	app, err := Open(Config{
		DatabasePath:     filepath.Join(dir, "comments.sqlite"),
		MediaDir:         filepath.Join(dir, "media"),
		AllowedOrigins:   []string{testOrigin},
		SecureCookies:    false,
		AllowNoTurnstile: true,
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dir, "comments.sqlite")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("database permissions: %v, mode %v", err, infoMode(info))
	}
	if info, err := os.Stat(filepath.Join(dir, "media")); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("media directory permissions: %v, mode %v", err, infoMode(info))
	}
	server := httptest.NewServer(app.Handler())
	t.Cleanup(func() {
		server.Close()
		app.Close()
	})
	return &testAPI{t: t, app: app, server: server}
}

func infoMode(info os.FileInfo) os.FileMode {
	if info == nil {
		return 0
	}
	return info.Mode().Perm()
}

func (api *testAPI) client() *http.Client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		api.t.Fatal(err)
	}
	return &http.Client{Jar: jar}
}

func (api *testAPI) json(client *http.Client, method, path string, input any, want int) map[string]any {
	api.t.Helper()
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			api.t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, api.server.URL+path, body)
	if err != nil {
		api.t.Fatal(err)
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet && method != http.MethodHead {
		req.Header.Set("Origin", testOrigin)
	}
	response, err := client.Do(req)
	if err != nil {
		api.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != want {
		api.t.Fatalf("%s %s: got %d, want %d: %s", method, path, response.StatusCode, want, data)
	}
	if len(data) == 0 {
		return nil
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		api.t.Fatalf("decode response: %v: %s", err, data)
	}
	return result
}

func (api *testAPI) register(client *http.Client, username string) string {
	api.t.Helper()
	result := api.json(client, http.MethodPost, "/v1/auth/register", map[string]any{
		"username": username, "password": "correct horse battery staple", "turnstile_token": "",
	}, http.StatusCreated)
	code, _ := result["recovery_code"].(string)
	if code == "" {
		api.t.Fatal("registration did not return a recovery code")
	}
	return code
}

func (api *testAPI) uploadPNG(client *http.Client) string {
	api.t.Helper()
	var imageData bytes.Buffer
	canvas := image.NewRGBA(image.Rect(0, 0, 2, 2))
	canvas.Set(0, 0, color.RGBA{R: 255, A: 255})
	if err := png.Encode(&imageData, canvas); err != nil {
		api.t.Fatal(err)
	}
	var body bytes.Buffer
	writer := newMultipartWriter(&body, "image.png", imageData.Bytes())
	req, err := http.NewRequest(http.MethodPost, api.server.URL+"/v1/uploads", &body)
	if err != nil {
		api.t.Fatal(err)
	}
	req.Header.Set("Content-Type", writer)
	req.Header.Set("Origin", testOrigin)
	response, err := client.Do(req)
	if err != nil {
		api.t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusCreated {
		api.t.Fatalf("upload: got %d: %s", response.StatusCode, data)
	}
	var result struct {
		Attachment struct {
			ID string `json:"id"`
		} `json:"attachment"`
	}
	if err := json.Unmarshal(data, &result); err != nil || result.Attachment.ID == "" {
		api.t.Fatalf("invalid upload response: %v: %s", err, data)
	}
	return result.Attachment.ID
}

func TestAccountCommentTreeImageAndRecovery(t *testing.T) {
	api := newTestAPI(t)
	alice := api.client()
	recoveryCode := api.register(alice, "Alice")

	rootResult := api.json(alice, http.MethodPost, "/v1/articles/xbar/comments", map[string]any{
		"body": "<script>alert('literal')</script>", "parent_id": nil, "attachment_ids": []string{},
	}, http.StatusCreated)
	rootID := rootResult["id"].(string)
	attachmentID := api.uploadPNG(alice)
	childResult := api.json(alice, http.MethodPost, "/v1/articles/xbar/comments", map[string]any{
		"body": "", "parent_id": rootID, "attachment_ids": []string{attachmentID},
	}, http.StatusCreated)
	childID := childResult["id"].(string)
	grandchildResult := api.json(alice, http.MethodPost, "/v1/articles/xbar/comments", map[string]any{
		"body": "level three", "parent_id": childID, "attachment_ids": []string{},
	}, http.StatusCreated)
	grandchildID := grandchildResult["id"].(string)
	api.json(alice, http.MethodPatch, "/v1/comments/"+childID, map[string]any{
		"body": "<i>still plain text</i>", "attachment_ids": []string{attachmentID},
	}, http.StatusNoContent)

	listed := api.json(alice, http.MethodGet, "/v1/articles/xbar/comments", nil, http.StatusOK)
	comments := listed["comments"].([]any)
	if len(comments) != 3 {
		t.Fatalf("got %d comments, want 3", len(comments))
	}
	byID := commentsByID(comments)
	root := byID[rootID]
	child := byID[childID]
	grandchild := byID[grandchildID]
	if root["body"] != "<script>alert('literal')</script>" {
		t.Fatalf("comment body was altered: %#v", root["body"])
	}
	if child["parent_id"] != rootID || child["body"] != "<i>still plain text</i>" || len(child["attachments"].([]any)) != 1 {
		t.Fatalf("nested image reply is incomplete: %#v", child)
	}
	if grandchild["parent_id"] != childID || grandchild["id"] != grandchildID {
		t.Fatalf("third-level reply is incomplete: %#v", grandchild)
	}

	mediaReq, _ := http.NewRequest(http.MethodGet, api.server.URL+"/media/"+attachmentID, nil)
	mediaResponse, err := alice.Do(mediaReq)
	if err != nil {
		t.Fatal(err)
	}
	mediaResponse.Body.Close()
	if mediaResponse.StatusCode != http.StatusOK || mediaResponse.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("media response: %d %q", mediaResponse.StatusCode, mediaResponse.Header.Get("Content-Type"))
	}
	if mediaResponse.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("revocable media must not be publicly cached: %q", mediaResponse.Header.Get("Cache-Control"))
	}

	api.json(alice, http.MethodDelete, "/v1/comments/"+rootID, nil, http.StatusNoContent)
	listed = api.json(alice, http.MethodGet, "/v1/articles/xbar/comments", nil, http.StatusOK)
	comments = listed["comments"].([]any)
	byID = commentsByID(comments)
	if len(comments) != 3 || byID[rootID]["deleted"] != true ||
		byID[childID]["id"] != childID || byID[grandchildID]["id"] != grandchildID {
		t.Fatalf("deletion did not preserve the reply tree: %#v", comments)
	}

	oldCookies := alice.Jar.Cookies(mustURL(t, api.server.URL))
	result := api.json(alice, http.MethodPost, "/v1/auth/recover", map[string]any{
		"username": "alice", "recovery_code": recoveryCode,
		"password": "a new correct horse battery", "turnstile_token": "",
	}, http.StatusOK)
	if result["recovery_code"] == recoveryCode || result["recovery_code"] == "" {
		t.Fatal("recovery code was not rotated")
	}
	oldClient := api.client()
	oldClient.Jar.SetCookies(mustURL(t, api.server.URL), oldCookies)
	oldSession := api.json(oldClient, http.MethodGet, "/v1/auth/session", nil, http.StatusOK)
	if oldSession["user"] != nil {
		t.Fatal("password recovery did not revoke old sessions")
	}
}

func TestModerationCORSAndJSONBoundaries(t *testing.T) {
	api := newTestAPI(t)
	adminRecovery, err := api.app.BootstrapAdmin(t.Context(), "owner", "owner password long enough")
	if err != nil || adminRecovery == "" {
		t.Fatalf("bootstrap admin: %v", err)
	}
	admin := api.client()
	api.json(admin, http.MethodPost, "/v1/auth/login", map[string]any{
		"username": "owner", "password": "owner password long enough", "turnstile_token": "",
	}, http.StatusOK)
	adminCookies := admin.Jar.Cookies(mustURL(t, api.server.URL))
	if _, err := api.app.BootstrapAdmin(t.Context(), "owner", "rotated owner password"); err != nil {
		t.Fatalf("rotate admin: %v", err)
	}
	staleAdmin := api.client()
	staleAdmin.Jar.SetCookies(mustURL(t, api.server.URL), adminCookies)
	if session := api.json(staleAdmin, http.MethodGet, "/v1/auth/session", nil, http.StatusOK); session["user"] != nil {
		t.Fatal("rotating administrator credentials did not revoke old sessions")
	}
	api.json(admin, http.MethodPost, "/v1/auth/login", map[string]any{
		"username": "owner", "password": "rotated owner password", "turnstile_token": "",
	}, http.StatusOK)
	alice := api.client()
	api.register(alice, "alice")
	created := api.json(alice, http.MethodPost, "/v1/articles/xbar/comments", map[string]any{
		"body": "evidence", "parent_id": nil, "attachment_ids": []string{},
	}, http.StatusCreated)
	id := created["id"].(string)

	api.json(admin, http.MethodPost, "/v1/mod/comments/"+id, map[string]any{"action": "hide"}, http.StatusNoContent)
	anonymous := api.client()
	listed := api.json(anonymous, http.MethodGet, "/v1/articles/xbar/comments", nil, http.StatusOK)
	item := listed["comments"].([]any)[0].(map[string]any)
	if item["hidden"] != true || item["body"] != "" {
		t.Fatalf("hidden comment leaked: %#v", item)
	}
	adminList := api.json(admin, http.MethodGet, "/v1/articles/xbar/comments", nil, http.StatusOK)
	if adminList["comments"].([]any)[0].(map[string]any)["body"] != "evidence" {
		t.Fatal("administrator cannot inspect hidden content")
	}
	var fakeImage bytes.Buffer
	fakeImageType := newMultipartWriter(&fakeImage, "fake.png", []byte(`<script>alert(1)</script>`))
	fakeImageRequest, _ := http.NewRequest(http.MethodPost, api.server.URL+"/v1/uploads", &fakeImage)
	fakeImageRequest.Header.Set("Content-Type", fakeImageType)
	fakeImageRequest.Header.Set("Origin", testOrigin)
	fakeImageResponse, err := alice.Do(fakeImageRequest)
	if err != nil {
		t.Fatal(err)
	}
	fakeImageResponse.Body.Close()
	if fakeImageResponse.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("fake image got %d", fakeImageResponse.StatusCode)
	}

	request, _ := http.NewRequest(http.MethodPost, api.server.URL+"/v1/auth/logout", nil)
	request.Header.Set("Origin", "https://evil.example")
	response, err := alice.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin unsafe request got %d", response.StatusCode)
	}

	badJSON, _ := http.NewRequest(http.MethodPost, api.server.URL+"/v1/auth/login", strings.NewReader(`{"username":"a","password":"b","turnstile_token":""} {}`))
	badJSON.Header.Set("Content-Type", "application/json")
	badJSON.Header.Set("Origin", testOrigin)
	response, err = anonymous.Do(badJSON)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("multiple JSON values got %d", response.StatusCode)
	}
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func commentsByID(items []any) map[string]map[string]any {
	result := make(map[string]map[string]any, len(items))
	for _, raw := range items {
		item := raw.(map[string]any)
		result[item["id"].(string)] = item
	}
	return result
}

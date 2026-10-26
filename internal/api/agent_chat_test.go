package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

func fakeAgentBridge(t *testing.T, handler http.HandlerFunc) (*agentBridge, func()) {
	t.Helper()
	backend := httptest.NewServer(handler)
	endpoint, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &agentBridge{
		service: endpoint, client: backend.Client(),
		access: strings.Repeat("x", 32), agent: "ben-pa",
	}, backend.Close
}

func TestAgentBridgeAuthIsIndependentOfPublicReads(t *testing.T) {
	b, done := fakeAgentBridge(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	})
	defer done()
	e := echo.New()
	e.GET("/sessions", func(c echo.Context) error { return c.String(http.StatusOK, "private") }, b.authorize)

	req := httptest.NewRequest(http.MethodGet, "/sessions", nil)
	resp := httptest.NewRecorder()
	e.ServeHTTP(resp, req)
	if resp.Code != http.StatusUnauthorized {
		t.Fatalf("no key: status=%d", resp.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/sessions", nil)
	req.Header.Set("X-Kiwi-Agent-Key", b.access)
	resp = httptest.NewRecorder()
	e.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK || resp.Body.String() != "private" {
		t.Fatalf("valid key: status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestAgentBridgeScopesSessionsToKiwiFS(t *testing.T) {
	b, done := fakeAgentBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/session/ses_allowed" {
			_, _ = w.Write([]byte("{\"data\":{\"id\":\"ses_allowed\",\"title\":\"KiwiFS ben-pa · Chat\",\"agent\":\"ben-pa\"}}"))
			return
		}
		_, _ = w.Write([]byte("{\"data\":{\"id\":\"ses_other\",\"title\":\"bb private conversation\"}}"))
	})
	defer done()
	if err := b.ownedSession(t.Context(), "ses_allowed"); err != nil {
		t.Fatalf("expected allowed session: %v", err)
	}
	if err := b.ownedSession(t.Context(), "ses_other"); err == nil {
		t.Fatal("unscoped session was accepted")
	}
	if err := b.ownedSession(t.Context(), "../private"); err == nil {
		t.Fatal("invalid path ID was accepted")
	}
}

func TestAgentBridgeContextAndPermissionBoundary(t *testing.T) {
	var promptText string
	b, done := fakeAgentBridge(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/session/ses_allowed":
			_, _ = w.Write([]byte("{\"data\":{\"id\":\"ses_allowed\",\"title\":\"KiwiFS ben-pa · Chat\",\"agent\":\"ben-pa\"}}"))
		case "/api/session/ses_allowed/prompt":
			raw, _ := io.ReadAll(r.Body)
			var prompt struct{ Text string }
			if err := json.Unmarshal(raw, &prompt); err != nil {
				t.Error(err)
			}
			promptText = prompt.Text
			_, _ = w.Write([]byte("{\"data\":{\"id\":\"inbox_1\"}}"))
		default:
			http.NotFound(w, r)
		}
	})
	defer done()

	e := echo.New()
	e.POST("/sessions/:id/messages", b.send, b.authorize)
	e.POST("/sessions/:id/permissions/:request/reply", b.reply, b.authorize)
	payload := "{\"text\":\"Review this\",\"context\":{\"path\":\"plan.md\",\"space\":\"docs\",\"version\":\"etag123\",\"selection\":{\"quote\":\"scope decision\"}}}"
	req := httptest.NewRequest(http.MethodPost, "/sessions/ses_allowed/messages", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kiwi-Agent-Key", b.access)
	resp := httptest.NewRecorder()
	e.ServeHTTP(resp, req)
	if resp.Code != http.StatusAccepted {
		t.Fatalf("prompt status %d: %s", resp.Code, resp.Body.String())
	}
	if !strings.Contains(promptText, "Selected quote:\nscope decision") ||
		!strings.Contains(promptText, "ETag: etag123") || !strings.Contains(promptText, "User request:\nReview this") {
		t.Fatalf("missing context provenance in prompt: %q", promptText)
	}
	req = httptest.NewRequest(http.MethodPost, "/sessions/ses_allowed/permissions/per_example/reply", strings.NewReader("{\"decision\":\"always\"}"))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Kiwi-Agent-Key", b.access)
	resp = httptest.NewRecorder()
	e.ServeHTTP(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("permanent allow should be rejected: %d", resp.Code)
	}
}

func TestAgentBridgeConfigurationFailsClosed(t *testing.T) {
	t.Setenv("KIWIFS_AGENT_URL", "http://10.1.2.3:4096")
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN", strings.Repeat("z", 32))
	if agentBridgeFromEnvironment() != nil {
		t.Fatal("cleartext non-loopback URL allowed")
	}
	t.Setenv("KIWIFS_AGENT_URL", "http://127.0.0.1:4096")
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN", "short")
	if agentBridgeFromEnvironment() != nil {
		t.Fatal("short access key enabled bridge")
	}
	t.Setenv("KIWIFS_AGENT_ACCESS_TOKEN", strings.Repeat("z", 32))
	if agentBridgeFromEnvironment() == nil {
		t.Fatal("valid loopback service was refused")
	}
}

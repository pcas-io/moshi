package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The wire the server answers on, without a server: a tools/call that got an
// answer, a hint that means "the broker is away", and the HTTP answers a
// human is likely to hit.

func toolAnswer(text string, isError bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer bt_test" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": isError},
		})
	}
}

func TestCallReturnsTheParsedToolResult(t *testing.T) {
	srv := httptest.NewServer(toolAnswer(`{"messages":[],"inbox_pending":2,"hint":"No new messages."}`, false))
	defer srv.Close()
	got, err := call(srv.URL+"/mcp", "bt_test", "mesh_receive", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if num(got["inbox_pending"]) != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestCallTellsA401Apart(t *testing.T) {
	srv := httptest.NewServer(toolAnswer("{}", false))
	defer srv.Close()
	_, err := call(srv.URL+"/mcp", "bt_wrong", "mesh_status", map[string]any{})
	var ce *callError
	if !asCallError(err, &ce) || ce.status != 401 {
		t.Fatalf("got %v", err)
	}
	if !strings.Contains(ce.Error(), "Not authorized") {
		t.Fatalf("got %q", ce.Error())
	}
}

func TestCallExplainsA404AsAWrongEndpoint(t *testing.T) {
	// The dashboard answers a JSON client on the wrong path with a sign-in
	// redirect or a 404; neither is "server error".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(404) }))
	defer srv.Close()
	_, err := call(srv.URL+"/nope", "bt_test", "mesh_status", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "/mcp") {
		t.Fatalf("got %v", err)
	}
}

func TestCallExplainsA405AsAWrongEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Allow", "POST"); w.WriteHeader(405) }))
	defer srv.Close()
	_, err := call(srv.URL+"/mcp/", "bt_test", "mesh_status", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "/mcp") {
		t.Fatalf("got %v", err)
	}
}

func TestCallPassesAToolErrorThrough(t *testing.T) {
	srv := httptest.NewServer(toolAnswer("Rate limit exceeded. Wait 3 seconds before retrying.", true))
	defer srv.Close()
	_, err := call(srv.URL+"/mcp", "bt_test", "mesh_send", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "Rate limit exceeded") {
		t.Fatalf("got %v", err)
	}
}

func TestCallReportsA429WithItsWait(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "120")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"too_many_failed_sign_ins","retry_after":120}`))
	}))
	defer srv.Close()
	_, err := call(srv.URL+"/mcp", "bt_test", "mesh_status", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "2 minutes") {
		t.Fatalf("got %v", err)
	}
}

func TestBrokerAwayIsReadFromTheHint(t *testing.T) {
	if !brokerAway(map[string]any{"messages": []any{}, "inbox_pending": nil, "hint": "nats_unavailable, retry shortly"}) {
		t.Fatal("a nats_unavailable hint means the broker is away")
	}
	if brokerAway(map[string]any{"messages": []any{}, "inbox_pending": float64(0), "hint": "No new messages."}) {
		t.Fatal("an empty inbox is not an outage")
	}
}

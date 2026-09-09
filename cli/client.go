package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// ── MCP Client ──────────────────────────────────────────────────

func mcpCall(url, token, tool string, args map[string]any) map[string]any {
	body := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/call",
		"params": map[string]any{
			"name":      tool,
			"arguments": args,
		},
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		fatal("Interner Fehler (JSON encode): %v", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		fatal("Interner Fehler (Request): %v", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		if strings.Contains(err.Error(), "no such host") {
			fatal("Server nicht erreichbar: %s\nPruefe MESH_URL oder --url", url)
		}
		if strings.Contains(err.Error(), "connection refused") {
			fatal("Verbindung abgelehnt: %s\nLaeuft der Server?", url)
		}
		if strings.Contains(err.Error(), "timeout") {
			fatal("Timeout bei Verbindung zu %s", url)
		}
		fatal("Verbindung fehlgeschlagen: %v", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		fatal("Antwort konnte nicht gelesen werden: %v", err)
	}

	if resp.StatusCode == 401 {
		fmt.Fprintln(os.Stderr, "moshi: Nicht autorisiert.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Moegliche Ursachen:")
		fmt.Fprintln(os.Stderr, "  - Token ist falsch oder abgelaufen")
		fmt.Fprintln(os.Stderr, "  - Agent wurde deaktiviert")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Token pruefen: echo $MESH_TOKEN")
		os.Exit(1)
	}

	if resp.StatusCode == 503 {
		fatal("Server ist ueberlastet oder nicht bereit (503). Versuche es gleich nochmal.")
	}

	if resp.StatusCode == 413 {
		fatal("Nachricht zu gross: Payload max. 256 KB. Kuerze den Inhalt oder teile ihn auf.")
	}

	if resp.StatusCode != 200 {
		fatal("Server-Fehler (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	var rpcResp map[string]any
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		fatal("Server-Antwort nicht lesbar. Antwort: %s", truncate(string(respBody), 200))
	}

	if rpcErr, ok := rpcResp["error"].(map[string]any); ok {
		msg := str(rpcErr["message"])
		fatal("%s", friendlyError(msg, url))
	}

	result, _ := rpcResp["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		fatal("Leere Antwort vom Server. Versuche es nochmal.")
	}

	first := content[0].(map[string]any)
	text := str(first["text"])

	if isErr, ok := result["isError"].(bool); ok && isErr {
		if strings.Contains(text, "not found") && strings.Contains(text, "mesh_status") {
			fatal("Agent nicht gefunden. Verfuegbare Agents: moshi status")
		}
		// Everything else (rate limit, admin-token hint, nats_unavailable,
		// …) is already a full sentence from the server — pass it through.
		fatal("%s", text)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		fatal("Antwort konnte nicht verarbeitet werden: %s", truncate(text, 200))
	}

	return parsed
}

// friendlyError rewrites the JSON-RPC error messages a human is likely
// to hit into actionable German; unknown ones are passed through.
func friendlyError(msg, url string) string {
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "too_big") || strings.Contains(lower, "too big") {
		return "Nachricht zu gross: Payload max. 256 KB, Kontext max. 2048 Zeichen. Kuerze den Inhalt oder teile ihn auf."
	}
	if strings.Contains(msg, "Not Acceptable") {
		return fmt.Sprintf("Server hat die Anfrage abgelehnt. Moeglicherweise falsche URL?\n  Aktuelle URL: %s", url)
	}
	if strings.Contains(lower, "validation error") || strings.Contains(lower, "invalid arguments") {
		return "Ungueltige Eingabe: " + msg
	}
	return "Server-Fehler: " + msg
}

// ── Helpers ─────────────────────────────────────────────────────

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

// num reads a JSON number field (float64 after Unmarshal) as int; missing
// or non-numeric values (e.g. inbox_pending: null) yield -1.
func num(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return -1
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func color(code, text string) string {
	if !isTTY() {
		return text
	}
	return code + text + "\033[0m"
}

// isTTY and stdinHasData are defined in tty_unix.go / tty_windows.go
// so we can keep the main CLI stdlib-only while still giving Windows
// users sensible behavior (no raw ANSI escape sequences in cmd.exe).

func hint(msg string) {
	fmt.Fprintf(os.Stderr, "  → %s\n", msg)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "moshi: "+format+"\n", args...)
	os.Exit(1)
}

// pendingHint prints how many messages are still waiting for this agent
// — every tool reply carries inbox_pending since the Top-5 review fixes.
func pendingHint(result map[string]any) {
	if n := num(result["inbox_pending"]); n > 0 {
		hint(fmt.Sprintf("%d Nachricht(en) warten in deiner Inbox: moshi receive", n))
	}
}

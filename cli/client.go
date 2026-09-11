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
		fatal("Internal error (JSON encode): %v", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		fatal("Internal error (request): %v", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		if strings.Contains(err.Error(), "no such host") {
			fatal("Cannot reach the server: %s\nCheck MESH_URL or --url", url)
		}
		if strings.Contains(err.Error(), "connection refused") {
			fatal("Connection refused: %s\nIs the server running?", url)
		}
		if strings.Contains(err.Error(), "timeout") {
			fatal("Timed out connecting to %s", url)
		}
		fatal("Connection failed: %v", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		fatal("Could not read the response: %v", err)
	}

	if resp.StatusCode == 401 {
		fmt.Fprintln(os.Stderr, "moshi: Not authorized.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Possible causes:")
		fmt.Fprintln(os.Stderr, "  - the token is wrong or expired")
		fmt.Fprintln(os.Stderr, "  - the agent was deactivated")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Check the token: echo $MESH_TOKEN")
		os.Exit(1)
	}

	if resp.StatusCode == 503 {
		fatal("Server is overloaded or not ready (503). Try again in a moment.")
	}

	if resp.StatusCode == 413 {
		fatal("Message too large: payload max. 256 KB. Shorten it or split it up.")
	}

	if resp.StatusCode != 200 {
		fatal("Server error (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	var rpcResp map[string]any
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		fatal("Could not parse the server response: %s", truncate(string(respBody), 200))
	}

	if rpcErr, ok := rpcResp["error"].(map[string]any); ok {
		msg := str(rpcErr["message"])
		fatal("%s", friendlyError(msg, url))
	}

	result, _ := rpcResp["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		fatal("Empty response from the server. Try again.")
	}

	first := content[0].(map[string]any)
	text := str(first["text"])

	if isErr, ok := result["isError"].(bool); ok && isErr {
		if strings.Contains(text, "not found") && strings.Contains(text, "mesh_status") {
			fatal("Agent not found. See who exists: moshi status")
		}
		// Everything else (rate limit, admin-token hint, nats_unavailable,
		// …) is already a full sentence from the server — pass it through.
		fatal("%s", text)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		fatal("Could not process the response: %s", truncate(text, 200))
	}

	return parsed
}

// friendlyError rewrites the JSON-RPC error messages a human is likely
// to hit into actionable advice; unknown ones are passed through.
func friendlyError(msg, url string) string {
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "too_big") || strings.Contains(lower, "too big") {
		return "Message too large: payload max. 256 KB, context max. 2048 chars. Shorten it or split it up."
	}
	if strings.Contains(msg, "Not Acceptable") {
		return fmt.Sprintf("The server rejected the request. Wrong URL?\n  Current URL: %s\n  It must point at the MCP endpoint and end in /mcp.", url)
	}
	if strings.Contains(lower, "validation error") || strings.Contains(lower, "invalid arguments") {
		return "Invalid input: " + msg
	}
	return "Server error: " + msg
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
		hint(fmt.Sprintf("%d message(s) waiting in your inbox: moshi receive", n))
	}
}

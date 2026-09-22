package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// ── MCP Client ──────────────────────────────────────────────────

// callError is what a call answers with when the server did: the HTTP
// status (0 for a tool error or a transport failure) and a sentence for the
// human. mcpCall prints it and exits; call itself never exits, so that it can
// be tested against an httptest server.
type callError struct {
	status int
	msg    string
}

func (e *callError) Error() string { return e.msg }

func asCallError(err error, target **callError) bool {
	ce, ok := err.(*callError)
	if ok {
		*target = ce
	}
	return ok
}

func mcpCall(url, token, tool string, args map[string]any) map[string]any {
	result, err := call(url, token, tool, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "moshi: "+err.Error())
		os.Exit(1)
	}
	return result
}

func call(url, token, tool string, args map[string]any) (map[string]any, error) {
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
		return nil, &callError{msg: fmt.Sprintf("Internal error (JSON encode): %v", err)}
	}

	req, err := http.NewRequest("POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, &callError{msg: fmt.Sprintf("Internal error (request): %v", err)}
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		if strings.Contains(err.Error(), "no such host") {
			return nil, &callError{msg: fmt.Sprintf("Cannot reach the server: %s\nCheck MESH_URL or --url", url)}
		}
		if strings.Contains(err.Error(), "connection refused") {
			return nil, &callError{msg: fmt.Sprintf("Connection refused: %s\nIs the server running?", url)}
		}
		if strings.Contains(err.Error(), "timeout") {
			return nil, &callError{msg: fmt.Sprintf("Timed out connecting to %s", url)}
		}
		return nil, &callError{msg: fmt.Sprintf("Connection failed: %v", err)}
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, &callError{msg: fmt.Sprintf("Could not read the response: %v", err)}
	}

	switch resp.StatusCode {
	case 200:
	case 401:
		return nil, &callError{status: 401, msg: "Not authorized.\n\n" +
			"  Possible causes:\n" +
			"  - the token is wrong or expired\n" +
			"  - the agent was deactivated\n\n" +
			"  Check the token: echo $MESH_TOKEN"}
	case 404, 405, 302, 303:
		// The dashboard, not the MCP endpoint: a wrong path answers a JSON
		// client with a sign-in redirect, a 404, or 405 on /mcp with a slash.
		return nil, &callError{status: resp.StatusCode, msg: fmt.Sprintf("Nothing answers MCP at %s (HTTP %d).\n  The endpoint is /mcp on the server: export MESH_URL=https://your.server (the path is added), or --url", url, resp.StatusCode)}
	case 429:
		wait := "a while"
		if secs, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && secs > 0 {
			wait = humanDuration(secs)
		}
		return nil, &callError{status: 429, msg: "Too many failed sign-ins from this network. Wrong tokens are turned away for " + wait + "; a correct token still works.\n  Check the token: echo $MESH_TOKEN"}
	case 503:
		return nil, &callError{status: 503, msg: "Server is overloaded or not ready (503). Try again in a moment."}
	case 413:
		return nil, &callError{status: 413, msg: "Message too large: payload max. 256 KB. Shorten it or split it up."}
	default:
		return nil, &callError{status: resp.StatusCode, msg: fmt.Sprintf("Server error (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))}
	}

	var rpcResp map[string]any
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		return nil, &callError{msg: fmt.Sprintf("Could not parse the server response: %s", truncate(string(respBody), 200))}
	}

	if rpcErr, ok := rpcResp["error"].(map[string]any); ok {
		return nil, &callError{msg: friendlyError(str(rpcErr["message"]), url)}
	}

	result, _ := rpcResp["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		return nil, &callError{msg: "Empty response from the server. Try again."}
	}

	first, _ := content[0].(map[string]any)
	text := str(first["text"])

	if isErr, ok := result["isError"].(bool); ok && isErr {
		if strings.Contains(text, "not found") && strings.Contains(text, "mesh_status") {
			return nil, &callError{msg: "Agent not found. See who exists: moshi status"}
		}
		// Everything else (rate limit, admin-token hint, nats_unavailable,
		// …) is already a full sentence from the server — pass it through.
		return nil, &callError{msg: text}
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		return nil, &callError{msg: fmt.Sprintf("Could not process the response: %s", truncate(text, 200))}
	}

	return parsed, nil
}

// brokerAway: the server answered, and said that the broker did not. A reply
// of mesh_receive then looks like an empty inbox, and is none.
func brokerAway(result map[string]any) bool {
	return strings.Contains(str(result["hint"]), "nats_unavailable")
}

func humanDuration(secs int) string {
	if secs >= 120 {
		return fmt.Sprintf("%d minutes", (secs+59)/60)
	}
	if secs >= 60 {
		return "a minute"
	}
	return fmt.Sprintf("%d seconds", secs)
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

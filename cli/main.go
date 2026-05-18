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

const defaultURL = "https://mesh.enki.run/mcp"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		fmt.Println()
		hint("Starte mit: moshi status")
		os.Exit(0)
	}

	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printUsage()
		os.Exit(0)
	}

	// Parse global flags
	url := env("MESH_URL", defaultURL)
	token := env("MESH_TOKEN", "")
	var remaining []string

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--url":
			if i+1 < len(args) {
				url = args[i+1]
				i++
			} else {
				fatal("--url braucht einen Wert, z.B. --url https://mesh.example.com/mcp")
			}
		case "--token":
			if i+1 < len(args) {
				token = args[i+1]
				i++
			} else {
				fatal("--token braucht einen Wert, z.B. --token bt_...")
			}
		default:
			remaining = append(remaining, args[i])
		}
	}

	if token == "" {
		fmt.Fprintln(os.Stderr, "moshi: Kein Token gesetzt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Option 1: export MESH_TOKEN=bt_dein_token")
		fmt.Fprintln(os.Stderr, "  Option 2: moshi --token bt_dein_token status")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Token bekommst du vom Admin im Dashboard: https://mesh.enki.run/agents")
		os.Exit(1)
	}

	if len(remaining) == 0 {
		printUsage()
		os.Exit(0)
	}

	cmd := remaining[0]
	cmdArgs := remaining[1:]

	switch cmd {
	case "status", "s":
		cmdStatus(url, token)
	case "send":
		cmdSend(url, token, cmdArgs)
	case "receive", "recv", "r":
		cmdReceive(url, token, cmdArgs)
	case "get", "pull":
		cmdGet(url, token, cmdArgs)
	case "reply":
		cmdReply(url, token, cmdArgs)
	case "history", "hist", "h":
		cmdHistory(url, token, cmdArgs)
	case "register", "reg":
		cmdRegister(url, token, cmdArgs)
	default:
		fmt.Fprintf(os.Stderr, "moshi: Unbekannter Befehl '%s'\n\n", cmd)
		fmt.Fprintln(os.Stderr, "Verfuegbare Befehle: status, send, receive, reply, history, register")
		fmt.Fprintln(os.Stderr, "Hilfe: moshi --help")
		os.Exit(1)
	}
}

// ── Commands ────────────────────────────────────────────────────

func cmdStatus(url, token string) {
	result := mcpCall(url, token, "mesh_status", map[string]any{})
	agents, _ := result["agents"].([]any)

	if len(agents) == 0 {
		fmt.Println("Keine Agents registriert.")
		hint("Erstelle Agents im Dashboard: https://mesh.enki.run/agents")
		return
	}

	fmt.Printf("%-18s %-15s %-8s %s\n", "AGENT", "ROLE", "STATUS", "WORKING ON")
	fmt.Println(strings.Repeat("─", 70))

	for _, a := range agents {
		ag := a.(map[string]any)
		name := str(ag["name"])
		role := str(ag["role"])
		if role == "" {
			role = "—"
		}
		online, _ := ag["online"].(bool)
		status := color("\033[31m", "offline")
		if online {
			status = color("\033[32m", "ONLINE")
		}
		workingOn := str(ag["working_on"])
		if workingOn == "" {
			workingOn = "—"
		}
		if len(workingOn) > 40 {
			workingOn = workingOn[:37] + "..."
		}
		fmt.Printf("%-18s %-15s %-8s %s\n", name, role, status, workingOn)
	}
	fmt.Printf("\n%d Agent(en)\n", len(agents))
}

func cmdSend(url, token string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi send: Empfaenger fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage:")
		fmt.Fprintln(os.Stderr, `    moshi send <agent> "nachricht"`)
		fmt.Fprintln(os.Stderr, `    echo "text" | moshi send <agent>`)
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Beispiele:")
		fmt.Fprintln(os.Stderr, `    moshi send ops "Server neugestartet"`)
		fmt.Fprintln(os.Stderr, `    moshi send ops "DB nicht erreichbar" --type incident`)
		fmt.Fprintln(os.Stderr, `    docker logs app 2>&1 | moshi send ops --type incident`)
		fmt.Fprintln(os.Stderr, `    moshi send broadcast "Wartung um 22 Uhr"`)
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Typ ist optional (default: info)")
		fmt.Fprintln(os.Stderr, "  Typen: info, question, incident, deploy_request, review_request, task_update, script")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Wer ist da?  moshi status")
		os.Exit(1)
	}

	to := args[0]
	msgType := "info"
	context := "moshi"
	hostname, _ := os.Hostname()
	if hostname != "" {
		context = "moshi@" + hostname
	}
	var payload string

	// Parse flags and collect payload args
	var payloadArgs []string
	for i := 1; i < len(args); i++ {
		if args[i] == "--type" && i+1 < len(args) {
			msgType = args[i+1]
			i++
		} else if args[i] == "--context" && i+1 < len(args) {
			context = args[i+1]
			i++
		} else {
			payloadArgs = append(payloadArgs, args[i])
		}
	}

	// Determine payload source (priority order):
	// 1. Explicit "-" → read stdin
	// 2. Payload argument(s) given → use them
	// 3. No payload but stdin is piped → read stdin automatically
	// 4. Nothing → error

	if len(payloadArgs) == 1 && payloadArgs[0] == "-" {
		// Explicit stdin marker
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatal("Stdin lesen fehlgeschlagen: %v", err)
		}
		payload = strings.TrimSpace(string(data))
	} else if len(payloadArgs) > 0 {
		// Payload as argument(s)
		payload = strings.Join(payloadArgs, " ")
	} else if stdinHasData() {
		// Auto-detect piped stdin
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatal("Stdin lesen fehlgeschlagen: %v", err)
		}
		payload = strings.TrimSpace(string(data))
	} else {
		fmt.Fprintf(os.Stderr, "moshi send %s: Nachricht fehlt.\n\n", to)
		fmt.Fprintln(os.Stderr, "  Drei Wege eine Nachricht zu senden:")
		fmt.Fprintf(os.Stderr, "    moshi send %s \"Dein Text hier\"\n", to)
		fmt.Fprintf(os.Stderr, "    echo \"Dein Text\" | moshi send %s\n", to)
		fmt.Fprintf(os.Stderr, "    cat datei.txt | moshi send %s\n", to)
		os.Exit(1)
	}

	if payload == "" {
		fmt.Fprintln(os.Stderr, "moshi send: Leere Nachricht. Nichts zu senden.")
		os.Exit(1)
	}

	// Warn if payload is approaching the 256 KB limit (>240 KB)
	payloadBytes := len([]byte(payload))
	if payloadBytes > 245760 {
		fmt.Fprintf(os.Stderr, "Warnung: Payload ist %d KB (Limit: 256 KB)\n", payloadBytes/1024)
	}

	params := map[string]any{
		"to":      to,
		"type":    msgType,
		"payload": payload,
		"context": context,
	}

	result := mcpCall(url, token, "mesh_send", params)
	fmt.Printf("✓ Gesendet an %s [%s] (%s)\n", to, msgType, str(result["id"]))
}

func cmdReceive(url, token string, args []string) {
	params := map[string]any{}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--limit":
			if i+1 < len(args) {
				n, err := strconv.Atoi(args[i+1])
				if err != nil {
					fatal("--limit braucht eine Zahl, z.B. --limit 10")
				}
				params["limit"] = n
				i++
			} else {
				fatal("--limit braucht eine Zahl, z.B. --limit 10")
			}
		case "--type":
			if i+1 < len(args) {
				params["type"] = args[i+1]
				i++
			} else {
				fatal("--type braucht einen Wert, z.B. --type question")
			}
		}
	}

	result := mcpCall(url, token, "mesh_receive", params)
	messages, _ := result["messages"].([]any)

	if len(messages) == 0 {
		fmt.Println("Keine neuen Nachrichten.")
		return
	}

	fmt.Printf("%-15s %-15s %-8s %s\n", "VON", "TYP", "ZEIT", "NACHRICHT")
	fmt.Println(strings.Repeat("─", 70))

	for i, m := range messages {
		msg := m.(map[string]any)
		from := str(msg["from"])
		msgType := str(msg["type"])
		created := str(msg["created_at"])
		payload := str(msg["payload"])
		msgID := str(msg["id"])
		context := str(msg["context"])

		t, err := time.Parse(time.RFC3339Nano, created)
		timeStr := created
		if err == nil {
			timeStr = t.Local().Format("15:04")
		}

		// Header
		fmt.Printf("[%s] %s %s → %s [%s]\n", timeStr, color("\033[1m", from), color("\033[33m", msgType), "du", msgID[:20]+"...")

		// Context
		if context != "" && context != "moshi" {
			fmt.Printf("  Kontext: %s\n", context)
		}

		// Full payload
		fmt.Println()
		for _, line := range strings.Split(payload, "\n") {
			fmt.Printf("  %s\n", line)
		}
		fmt.Println()

		// Reply hint
		fmt.Printf("  → %s\n", color("\033[2m", fmt.Sprintf("moshi reply %s \"antwort\"", msgID)))

		if i < len(messages)-1 {
			fmt.Println(strings.Repeat("─", 70))
		}
	}

	fmt.Printf("\n%d Nachricht(en)\n", len(messages))
}

func cmdGet(url, token string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi get: Message-ID fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi get <message_id>")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Gibt nur die rohe Payload aus — ideal zum Pipen:")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... > script.sh")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... | bash")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... | python3")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Message-IDs findest du in: moshi receive")
		os.Exit(1)
	}

	msgID := args[0]

	// Use mesh_history to fetch the specific message by ID
	result := mcpCall(url, token, "mesh_history", map[string]any{
		"correlation_id": msgID,
	})

	messages, _ := result["messages"].([]any)
	for _, m := range messages {
		msg := m.(map[string]any)
		if str(msg["id"]) == msgID {
			fmt.Print(str(msg["payload"]))
			return
		}
	}

	// Message not found in thread — might be a standalone message
	// Try with the ID as the message itself
	if len(messages) == 1 {
		msg := messages[0].(map[string]any)
		fmt.Print(str(msg["payload"]))
		return
	}

	fatal("Nachricht %s nicht gefunden.", msgID)
}

func cmdReply(url, token string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi reply: Message-ID fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi reply <message_id> <antwort>")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Die Message-ID findest du in der Ausgabe von: moshi receive")
		os.Exit(1)
	}

	if len(args) == 1 {
		fmt.Fprintf(os.Stderr, "moshi reply: Antworttext fehlt.\n\n")
		fmt.Fprintf(os.Stderr, "  Beispiel: moshi reply %s \"Deine Antwort\"\n", args[0])
		os.Exit(1)
	}

	msgID := args[0]
	payload := args[1]

	if payload == "-" || (len(args) == 2 && stdinHasData()) {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatal("Stdin lesen fehlgeschlagen: %v", err)
		}
		payload = strings.TrimRight(string(data), "\n")
	}

	params := map[string]any{
		"message_id": msgID,
		"payload":    payload,
		"context":    "moshi",
	}

	result := mcpCall(url, token, "mesh_reply", params)
	fmt.Printf("✓ Antwort gesendet (%s)\n", str(result["id"]))
}

func cmdHistory(url, token string, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "moshi history: Thread-ID fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi history <message_id>")
		fmt.Fprintln(os.Stderr, "  Zeigt alle Nachrichten in einem Thread (Frage + Antworten).")
		os.Exit(1)
	}

	params := map[string]any{
		"correlation_id": args[0],
	}

	result := mcpCall(url, token, "mesh_history", params)
	messages, _ := result["messages"].([]any)

	if len(messages) == 0 {
		fmt.Println("Keine Nachrichten in diesem Thread.")
		return
	}

	fmt.Printf("Thread: %s (%d Nachrichten)\n\n", args[0], len(messages))

	for _, m := range messages {
		msg := m.(map[string]any)
		from := str(msg["from"])
		to := str(msg["to"])
		msgType := str(msg["type"])
		payload := str(msg["payload"])
		created := str(msg["created_at"])

		t, err := time.Parse(time.RFC3339Nano, created)
		timeStr := created
		if err == nil {
			timeStr = t.Local().Format("15:04:05")
		}

		fmt.Printf("  [%s] %s → %s [%s]\n", timeStr, from, to, msgType)
		for _, line := range strings.Split(payload, "\n") {
			if line != "" {
				fmt.Printf("    %s\n", line)
			}
		}
		fmt.Println()
	}
}

func cmdRegister(url, token string, args []string) {
	hostname, _ := os.Hostname()
	params := map[string]any{
		"role":         "cli",
		"capabilities": []string{"bash", "pipe", "ssh"},
	}
	if hostname != "" {
		params["working_on"] = "moshi@" + hostname
	}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--capabilities":
			if i+1 < len(args) {
				params["capabilities"] = strings.Split(args[i+1], ",")
				i++
			} else {
				fatal("--capabilities braucht einen Wert, z.B. --capabilities ssh,docker")
			}
		case "--working-on":
			if i+1 < len(args) {
				params["working_on"] = args[i+1]
				i++
			} else {
				fatal("--working-on braucht einen Wert, z.B. --working-on \"Debugging\"")
			}
		}
	}

	mcpCall(url, token, "mesh_register", params)
	fmt.Printf("✓ Registriert als cli (%s)\n", hostname)
}

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

	if resp.StatusCode != 200 {
		fatal("Server-Fehler (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	var rpcResp map[string]any
	if err := json.Unmarshal(respBody, &rpcResp); err != nil {
		fatal("Server-Antwort nicht lesbar. Antwort: %s", truncate(string(respBody), 200))
	}

	if rpcErr, ok := rpcResp["error"].(map[string]any); ok {
		msg := str(rpcErr["message"])
		// Make common errors more readable
		if strings.Contains(msg, "too_big") || strings.Contains(msg, "Too big") || strings.Contains(msg, "65536") {
			fatal("Nachricht zu gross (max 64 KB). Kuerze den Inhalt oder teile ihn auf.")
		}
		if strings.Contains(msg, "Not Acceptable") {
			fatal("Server hat die Anfrage abgelehnt. Moeglicherweise falsche URL?\n  Aktuelle URL: %s", url)
		}
		if strings.Contains(msg, "validation error") || strings.Contains(msg, "Invalid arguments") {
			fatal("Ungueltige Eingabe: %s", msg)
		}
		fatal("Server-Fehler: %s", msg)
	}

	result, _ := rpcResp["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		fatal("Leere Antwort vom Server. Versuche es nochmal.")
	}

	first := content[0].(map[string]any)
	text := str(first["text"])

	if isErr, ok := result["isError"].(bool); ok && isErr {
		if strings.Contains(text, "not found") {
			fatal("Agent nicht gefunden. Verfuegbare Agents: moshi status")
		}
		if strings.Contains(text, "Rate limit") {
			fatal("%s", text)
		}
		if strings.Contains(text, "too_big") || strings.Contains(text, "Too big") || strings.Contains(text, "65536") {
			fatal("Nachricht zu gross (max 64 KB). Kuerze den Inhalt oder teile ihn auf.")
		}
		fatal("Fehler: %s", text)
	}

	// Also check raw response body for oversized payload errors
	if strings.Contains(string(respBody), "too_big") || strings.Contains(string(respBody), "65536") {
		fatal("Nachricht zu gross (max 64 KB). Kuerze den Inhalt oder teile ihn auf.")
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		fatal("Antwort konnte nicht verarbeitet werden: %s", truncate(text, 200))
	}

	return parsed
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

func printUsage() {
	fmt.Print(`moshi — もしもし · async chat zwischen Agenten & Menschen

Befehle:
  moshi status                        Wer ist online?
  moshi send <agent> "nachricht"      Nachricht senden (Typ: info)
  moshi receive                       Neue Nachrichten abholen
  moshi get <msg_id>                  Rohe Payload ausgeben (pipebar!)
  moshi reply <msg_id> "antwort"      Auf Nachricht antworten
  moshi history <msg_id>              Thread-Verlauf anzeigen
  moshi register                      Als CLI-Agent registrieren

Nachrichten senden:
  moshi send ops "Server laeuft"                   Direkt als Text
  moshi send ops "DB down" --type incident          Mit Typ
  echo "logs" | moshi send ops                      Piped (auto)
  echo "logs" | moshi send ops --type incident      Piped mit Typ
  cat datei.txt | moshi send ops                    Datei senden
  moshi send broadcast "Wartung um 22 Uhr"          An alle

Scripts & Dateien:
  moshi get <msg_id> > script.sh      Payload als Datei speichern
  moshi get <msg_id> | bash           Script direkt ausfuehren
  moshi get <msg_id> | python3        Python-Script ausfuehren

Optionen:
  --token <t>     Token (oder: export MESH_TOKEN=bt_...)
  --url <u>       Server-URL (default: mesh.enki.run)
  --type <t>      Nachrichtentyp fuer send (default: info)
  --context <c>   Kontext fuer send (default: moshi@hostname)
  --limit <n>     Max Nachrichten fuer receive
  --working-on <> Aktuelle Aufgabe fuer register

Kurzformen: s=status, r=receive, h=history, reg=register, get=pull
`)
}

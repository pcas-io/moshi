package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Full payload size the server accepts — `moshi receive` asks for it so a
// human always sees the whole message, unlike agents, which get previews.
const fullPayloadChars = 262144

// Message types the server recommends (free-form values are accepted too).
var knownTypes = []string{
	"info", "question", "incident", "task_update",
	"deploy_request", "deploy_status", "review_request", "review_result", "script",
}

func isKnownType(s string) bool {
	for _, t := range knownTypes {
		if t == s {
			return true
		}
	}
	return false
}

// ── Commands ────────────────────────────────────────────────────

func cmdStatus(url, token string) {
	result := mcpCall(url, token, "mesh_status", map[string]any{})
	agents, _ := result["agents"].([]any)

	if len(agents) == 0 {
		fmt.Println("Keine Agents registriert.")
		hint("Erstelle Agents im Dashboard: " + baseURL(url) + "/agents")
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
	pendingHint(result)
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
		fmt.Fprintln(os.Stderr, `    docker logs app 2>&1 | moshi send ops incident      (Kurzform)`)
		fmt.Fprintln(os.Stderr, `    moshi send broadcast "Wartung um 22 Uhr"`)
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Typ ist optional (default: info)")
		fmt.Fprintln(os.Stderr, "  Typen: "+strings.Join(knownTypes, ", "))
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Wer ist da?  moshi status")
		os.Exit(1)
	}

	to := args[0]
	msgType := ""
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

	piped := stdinHasData()

	// Determine payload source (priority order):
	// 1. Explicit "-" → read stdin
	// 2. Piped stdin + exactly one word that is a known type → that word is
	//    the type, stdin is the payload (`docker logs … | moshi send ops incident`)
	// 3. Payload argument(s) given → use them
	// 4. No payload but stdin is piped → read stdin automatically
	// 5. Nothing → error

	if len(payloadArgs) == 1 && payloadArgs[0] == "-" {
		payload = readStdin()
	} else if piped && msgType == "" && len(payloadArgs) == 1 && isKnownType(payloadArgs[0]) {
		msgType = payloadArgs[0]
		payload = readStdin()
	} else if len(payloadArgs) > 0 {
		payload = strings.Join(payloadArgs, " ")
	} else if piped {
		payload = readStdin()
	} else {
		fmt.Fprintf(os.Stderr, "moshi send %s: Nachricht fehlt.\n\n", to)
		fmt.Fprintln(os.Stderr, "  Drei Wege eine Nachricht zu senden:")
		fmt.Fprintf(os.Stderr, "    moshi send %s \"Dein Text hier\"\n", to)
		fmt.Fprintf(os.Stderr, "    echo \"Dein Text\" | moshi send %s\n", to)
		fmt.Fprintf(os.Stderr, "    cat datei.txt | moshi send %s\n", to)
		os.Exit(1)
	}

	if msgType == "" {
		msgType = "info"
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
	if h := str(result["hint"]); h != "" {
		hint(h)
	}
	pendingHint(result)
}

func readStdin() string {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fatal("Stdin lesen fehlgeschlagen: %v", err)
	}
	return strings.TrimSpace(string(data))
}

func cmdReceive(url, token string, args []string) {
	// Humans get the whole payload — previews are for agents.
	params := map[string]any{"preview_chars": fullPayloadChars}

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
			fatal("--type gibt es bei receive nicht mehr: der Filter liess nicht passende Nachrichten unbestaetigt und verlor sie nach mehreren Abrufen. Alles abholen mit: moshi receive — Threads nach Typ ansehen im Dashboard oder mit moshi history <msg_id>.")
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
	if n := num(result["inbox_pending"]); n > 0 {
		hint(fmt.Sprintf("%d weitere Nachricht(en) warten: moshi receive", n))
	}
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

	// mesh_get returns the single message with its complete payload.
	result := mcpCall(url, token, "mesh_get", map[string]any{
		"message_id": args[0],
	})
	fmt.Print(str(result["payload"]))
}

func cmdReply(url, token string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi reply: Message-ID fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi reply <message_id> <antwort> [--type review_result]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Die Message-ID findest du in der Ausgabe von: moshi receive")
		os.Exit(1)
	}

	msgID := args[0]
	msgType := ""
	var rest []string
	for i := 1; i < len(args); i++ {
		if args[i] == "--type" && i+1 < len(args) {
			msgType = args[i+1]
			i++
		} else {
			rest = append(rest, args[i])
		}
	}

	var payload string
	if len(rest) == 1 && rest[0] == "-" {
		payload = strings.TrimRight(readStdin(), "\n")
	} else if len(rest) > 0 {
		payload = strings.Join(rest, " ")
	} else if stdinHasData() {
		payload = strings.TrimRight(readStdin(), "\n")
	} else {
		fmt.Fprintf(os.Stderr, "moshi reply: Antworttext fehlt.\n\n")
		fmt.Fprintf(os.Stderr, "  Beispiel: moshi reply %s \"Deine Antwort\"\n", msgID)
		os.Exit(1)
	}

	params := map[string]any{
		"message_id": msgID,
		"payload":    payload,
		"context":    "moshi",
	}
	if msgType != "" {
		params["type"] = msgType
	}

	result := mcpCall(url, token, "mesh_reply", params)
	fmt.Printf("✓ Antwort gesendet (%s)\n", str(result["id"]))
	pendingHint(result)
}

func cmdHistory(url, token string, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "moshi history: Thread-ID fehlt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi history <message_id>")
		fmt.Fprintln(os.Stderr, "  Zeigt alle Nachrichten in einem Thread (Frage + Antworten) — jede ID des Threads reicht.")
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

	threadID := str(result["thread_id"])
	if threadID == "" {
		threadID = args[0]
	}
	fmt.Printf("Thread: %s (%d Nachrichten)\n\n", threadID, len(messages))

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
	role := "cli"
	params := map[string]any{
		"capabilities": []string{"bash", "pipe", "ssh"},
	}
	if hostname != "" {
		params["working_on"] = "moshi@" + hostname
	}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--role":
			if i+1 < len(args) {
				role = args[i+1]
				i++
			} else {
				fatal("--role braucht einen Wert, z.B. --role ops")
			}
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
	params["role"] = role

	result := mcpCall(url, token, "mesh_register", params)
	fmt.Printf("✓ Registriert als %s (%s)\n", role, hostname)
	pendingHint(result)
}

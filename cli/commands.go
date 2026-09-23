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

// status, get and history take no flags of their own. They went through no
// parser at all, so `moshi get --url msg_1` or a mistyped `--limit` was
// silently taken as an argument and the command asked the server for a
// message called "--limit". Refusing it names the mistake where it was made.
func noFlags(command string, args []string) []string {
	p, err := parseArgs(args, nil)
	if err != nil {
		fatal("%s: %v", command, err)
	}
	return p.rest
}

func cmdStatus(url, token string, args []string) {
	noFlags("status", args)
	result := mcpCall(url, token, "mesh_status", map[string]any{})
	agents, _ := result["agents"].([]any)

	if len(agents) == 0 {
		fmt.Println("No agents registered.")
		hint("Create agents in the dashboard: " + baseURL(url) + "/agents")
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
	fmt.Printf("\n%d agent(s)\n", len(agents))
	pendingHint(result)
}

func cmdSend(url, token string, args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi send: recipient missing.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage:")
		fmt.Fprintln(os.Stderr, `    moshi send <agent> "message"`)
		fmt.Fprintln(os.Stderr, `    echo "text" | moshi send <agent>`)
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Examples:")
		fmt.Fprintln(os.Stderr, `    moshi send ops "server restarted"`)
		fmt.Fprintln(os.Stderr, `    moshi send ops "DB unreachable" --type incident`)
		fmt.Fprintln(os.Stderr, `    docker logs app 2>&1 | moshi send ops --type incident`)
		fmt.Fprintln(os.Stderr, `    docker logs app 2>&1 | moshi send ops incident      (shorthand)`)
		fmt.Fprintln(os.Stderr, `    moshi send broadcast "maintenance at 22:00"`)
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Type is optional (default: info)")
		fmt.Fprintln(os.Stderr, "  Types: "+strings.Join(knownTypes, ", "))
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Who is around?  moshi status")
		os.Exit(1)
	}

	to := args[0]
	context := "moshi"
	hostname, _ := os.Hostname()
	if hostname != "" {
		context = "moshi@" + hostname
	}
	var payload string

	p, err := parseArgs(args[1:], []string{"type", "context"})
	if err != nil {
		fatal("send: %v", err)
	}
	msgType := p.flags["type"]
	if c, ok := p.flags["context"]; ok {
		// An empty one passes the server's schema and is stored. Context is
		// mandatory for a reason: a recipient is told to read it before
		// acting. Refusing beats silently putting the hostname there.
		if strings.TrimSpace(c) == "" {
			fatal("--context needs a value: what you are doing, e.g. --context \"deploy of web-01\"")
		}
		context = c
	}
	payloadArgs := p.rest

	piped := stdinHasData()

	// Determine payload source (priority order):
	// 1. Explicit "-" → read stdin
	// 2. Piped stdin WITH DATA + exactly one word that is a known type → that
	//    word is the type, stdin is the payload (`docker logs … | moshi send ops incident`).
	//    When the pipe is empty the word is the message: `moshi send ops info`
	//    from a cron job used to wait on a silent stdin and send nothing.
	// 3. Payload argument(s) given → use them
	// 4. No payload but stdin is piped → read stdin automatically
	// 5. Nothing → error

	if len(payloadArgs) == 1 && payloadArgs[0] == "-" {
		payload = readStdin()
	} else if piped && msgType == "" && len(payloadArgs) == 1 && isKnownType(payloadArgs[0]) {
		if in := readStdin(); in != "" {
			msgType = payloadArgs[0]
			payload = in
		} else {
			payload = payloadArgs[0]
		}
	} else if len(payloadArgs) > 0 {
		payload = strings.Join(payloadArgs, " ")
	} else if piped {
		payload = readStdin()
	} else {
		fmt.Fprintf(os.Stderr, "moshi send %s: message missing.\n\n", to)
		fmt.Fprintln(os.Stderr, "  Three ways to send a message:")
		fmt.Fprintf(os.Stderr, "    moshi send %s \"your text here\"\n", to)
		fmt.Fprintf(os.Stderr, "    echo \"your text\" | moshi send %s\n", to)
		fmt.Fprintf(os.Stderr, "    cat file.txt | moshi send %s\n", to)
		os.Exit(1)
	}

	if msgType == "" {
		msgType = "info"
	}

	if payload == "" {
		fmt.Fprintln(os.Stderr, "moshi send: empty message. Nothing to send.")
		os.Exit(1)
	}

	// Warn if payload is approaching the 256 KB limit (>240 KB)
	payloadBytes := len([]byte(payload))
	if payloadBytes > 245760 {
		fmt.Fprintf(os.Stderr, "Warning: payload is %d KB (limit: 256 KB)\n", payloadBytes/1024)
	}

	params := map[string]any{
		"to":      to,
		"type":    msgType,
		"payload": payload,
		"context": context,
	}

	result := mcpCall(url, token, "mesh_send", params)
	fmt.Printf("✓ Sent to %s [%s] (%s)\n", to, msgType, str(result["id"]))
	if h := str(result["hint"]); h != "" {
		hint(h)
	}
	pendingHint(result)
}

func readStdin() string {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		fatal("Reading stdin failed: %v", err)
	}
	return strings.TrimSpace(string(data))
}

func cmdReceive(url, token string, args []string) {
	// Humans get the whole payload — previews are for agents.
	params := map[string]any{"preview_chars": fullPayloadChars}

	p, err := parseArgs(args, []string{"limit"})
	if err != nil {
		if strings.Contains(err.Error(), "--type") {
			fatal("receive has no --type filter any more: it left messages of other types unacknowledged and lost them after a few pulls. Fetch everything with: moshi receive; look at a thread by type in the dashboard or with moshi history <msg_id>.")
		}
		fatal("receive: %v", err)
	}
	if v, ok := p.flags["limit"]; ok {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			fatal("--limit needs a number, e.g. --limit 10")
		}
		params["limit"] = n
	}
	if len(p.rest) > 0 {
		fatal("receive takes no message: %s", strings.Join(p.rest, " "))
	}

	result := mcpCall(url, token, "mesh_receive", params)
	messages, _ := result["messages"].([]any)

	// The server answered, its broker did not: that is no empty inbox. Exit
	// 2, so that a script can tell "nothing there" from "could not look".
	if brokerAway(result) {
		fmt.Fprintln(os.Stderr, "moshi: the server cannot reach its message broker right now. Nothing was read; try again shortly.")
		os.Exit(2)
	}

	if len(messages) == 0 {
		fmt.Println("No new messages.")
		if n := num(result["expired_dropped"]); n > 0 {
			hint(fmt.Sprintf("%d message(s) had expired before you read them and were dropped.", n))
		}
		return
	}
	fmt.Printf("%-15s %-15s %-8s %s\n", "FROM", "TYPE", "TIME", "MESSAGE")
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
		fmt.Printf("[%s] %s %s → %s [%s]\n", timeStr, color("\033[1m", from), color("\033[33m", msgType), "you", msgID[:20]+"...")

		// Context
		if context != "" && context != "moshi" {
			fmt.Printf("  Context: %s\n", context)
		}

		// Full payload
		fmt.Println()
		for _, line := range strings.Split(payload, "\n") {
			fmt.Printf("  %s\n", line)
		}
		fmt.Println()

		// Reply hint
		fmt.Printf("  → %s\n", color("\033[2m", fmt.Sprintf("moshi reply %s \"your answer\"", msgID)))

		if i < len(messages)-1 {
			fmt.Println(strings.Repeat("─", 70))
		}
	}

	fmt.Printf("\n%d message(s)\n", len(messages))
	// Also here, not only in the empty case: the pull tops its limit up with
	// valid messages, so a batch that dropped expired ones is the designed
	// case and the one where the count went missing.
	if n := num(result["expired_dropped"]); n > 0 {
		hint(fmt.Sprintf("%d message(s) had expired before you read them and were dropped.", n))
	}
	if n := num(result["inbox_pending"]); n > 0 {
		hint(fmt.Sprintf("%d more message(s) waiting: moshi receive", n))
	}
}

func cmdGet(url, token string, args []string) {
	args = noFlags("get", args)
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "moshi get: message ID missing.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi get <message_id>")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Prints the raw payload and nothing else — made for piping:")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... > script.sh")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... | bash")
		fmt.Fprintln(os.Stderr, "    moshi get msg_01ABC... | python3")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Message IDs come from: moshi receive")
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
		fmt.Fprintln(os.Stderr, "moshi reply: message ID missing.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi reply <message_id> <answer> [--type review_result] [--context <c>]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  The message ID is in the output of: moshi receive")
		os.Exit(1)
	}

	msgID := args[0]
	p, err := parseArgs(args[1:], []string{"type", "context"})
	if err != nil {
		fatal("reply: %v", err)
	}
	msgType := p.flags["type"]
	context := "moshi"
	if hostname, _ := os.Hostname(); hostname != "" {
		context = "moshi@" + hostname
	}
	if c, ok := p.flags["context"]; ok {
		if strings.TrimSpace(c) == "" {
			fatal("--context needs a value: what you are doing, e.g. --context \"deploy of web-01\"")
		}
		context = c
	}
	rest := p.rest

	var payload string
	if len(rest) == 1 && rest[0] == "-" {
		payload = strings.TrimRight(readStdin(), "\n")
	} else if len(rest) > 0 {
		payload = strings.Join(rest, " ")
	} else if stdinHasData() {
		payload = strings.TrimRight(readStdin(), "\n")
	} else {
		fmt.Fprintf(os.Stderr, "moshi reply: answer text missing.\n\n")
		fmt.Fprintf(os.Stderr, "  Example: moshi reply %s \"your answer\"\n", msgID)
		os.Exit(1)
	}

	params := map[string]any{
		"message_id": msgID,
		"payload":    payload,
		"context":    context,
	}
	if msgType != "" {
		params["type"] = msgType
	}

	result := mcpCall(url, token, "mesh_reply", params)
	fmt.Printf("✓ Reply sent (%s)\n", str(result["id"]))
	pendingHint(result)
}

func cmdHistory(url, token string, args []string) {
	args = noFlags("history", args)
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "moshi history: thread ID missing.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Usage: moshi history <message_id>")
		fmt.Fprintln(os.Stderr, "  Shows every message in a thread (question + replies) — any ID from the thread works.")
		os.Exit(1)
	}

	params := map[string]any{
		"correlation_id": args[0],
	}

	result := mcpCall(url, token, "mesh_history", params)
	messages, _ := result["messages"].([]any)

	if len(messages) == 0 {
		fmt.Println("No messages in this thread.")
		return
	}

	threadID := str(result["thread_id"])
	if threadID == "" {
		threadID = args[0]
	}
	fmt.Printf("Thread: %s (%d messages)\n\n", threadID, len(messages))

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

	p, err := parseArgs(args, []string{"role", "capabilities", "working-on"})
	if err != nil {
		fatal("register: %v", err)
	}
	if len(p.rest) > 0 {
		fatal("register takes flags only (--role, --capabilities, --working-on), not: %s", strings.Join(p.rest, " "))
	}
	if v, ok := p.flags["role"]; ok {
		role = v
	}
	if v, ok := p.flags["capabilities"]; ok {
		params["capabilities"] = strings.Split(v, ",")
	}
	if v, ok := p.flags["working-on"]; ok {
		params["working_on"] = v
	}
	params["role"] = role

	result := mcpCall(url, token, "mesh_register", params)
	fmt.Printf("✓ Registered as %s (%s)\n", role, hostname)
	pendingHint(result)
}

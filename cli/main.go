package main

import (
	"fmt"
	"os"
)

const defaultURL = "https://moshi.enki.run/mcp"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage()
		fmt.Println()
		hint("Start with: moshi status")
		os.Exit(0)
	}

	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printUsage()
		os.Exit(0)
	}

	if args[0] == "--version" || args[0] == "-v" || args[0] == "version" {
		printVersion()
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
				fatal("--url needs a value, e.g. --url https://mesh.example.com/mcp")
			}
		case "--token":
			if i+1 < len(args) {
				token = args[i+1]
				i++
			} else {
				fatal("--token needs a value, e.g. --token bt_...")
			}
		default:
			remaining = append(remaining, args[i])
		}
	}

	// Commands that need neither a token nor (only) the server URL.
	if len(remaining) > 0 {
		switch remaining[0] {
		case "--version", "-v", "version":
			printVersion()
			os.Exit(0)
		case "self-update", "update", "upgrade":
			cmdSelfUpdate(url)
			os.Exit(0)
		}
	}

	if token == "" {
		fmt.Fprintln(os.Stderr, "moshi: No token set.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Option 1: export MESH_TOKEN=bt_your_token")
		fmt.Fprintln(os.Stderr, "  Option 2: moshi --token bt_your_token status")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Ask your admin for a token in the dashboard: "+baseURL(url)+"/agents")
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
		fmt.Fprintf(os.Stderr, "moshi: Unknown command '%s'\n\n", cmd)
		fmt.Fprintln(os.Stderr, "Available commands: status, send, receive, get, reply, history, register, self-update")
		fmt.Fprintln(os.Stderr, "Help: moshi --help")
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(`moshi — もしもし · async chat between agents and humans

Commands:
  moshi status                        Who is online? (+ unread messages)
  moshi send <agent> "message"        Send a message (type: info)
  moshi receive                       Fetch new messages (reading acks them!)
  moshi get <msg_id>                  Print the raw payload (pipe it!)
  moshi reply <msg_id> "answer"       Reply to a message
  moshi history <msg_id>              Show the thread (any ID from the thread)
  moshi register                      Register as a CLI agent
  moshi self-update                   Update to the latest server build
  moshi --version                     Show the version (build hash)

Install / update without the repo:
  curl -fsSL https://moshi.enki.run/install.sh | sh
  moshi self-update                   (any time after that, no curl needed)

Sending messages:
  moshi send ops "server is up"                    Plain text
  moshi send ops "DB down" --type incident          With a type
  echo "logs" | moshi send ops                      Piped (auto)
  echo "logs" | moshi send ops --type incident      Piped with a type
  docker logs app 2>&1 | moshi send ops incident    Shorthand: type as the only word
  cat file.txt | moshi send ops                     Send a file
  moshi send broadcast "maintenance at 22:00"       To everyone

Types: info (default), question, incident, task_update, deploy_request,
       deploy_status, review_request, review_result, script

Scripts and files:
  moshi get <msg_id> > script.sh      Save the payload to a file
  moshi get <msg_id> | bash           Run the script directly
  moshi get <msg_id> | python3        Run a Python script

Options:
  --token <t>     Token (or: export MESH_TOKEN=bt_...)
  --url <u>       MCP endpoint, must end in /mcp (or: export MESH_URL=...;
                  default: https://moshi.enki.run/mcp)
  --type <t>      Message type for send/reply (default: info / reply)
  --context <c>   Context for send (default: moshi@hostname)
  --limit <n>     Max messages for receive (default 10, max 50)
  --role <r>      Role for register (default: cli)
  --working-on <> Current task for register

Shorthands: s=status, r=receive, h=history, reg=register, get=pull
`)
}

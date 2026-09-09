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
		hint("Starte mit: moshi status")
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
		fmt.Fprintln(os.Stderr, "moshi: Kein Token gesetzt.")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Option 1: export MESH_TOKEN=bt_dein_token")
		fmt.Fprintln(os.Stderr, "  Option 2: moshi --token bt_dein_token status")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  Token bekommst du vom Admin im Dashboard: "+baseURL(url)+"/agents")
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
		fmt.Fprintln(os.Stderr, "Verfuegbare Befehle: status, send, receive, get, reply, history, register, self-update")
		fmt.Fprintln(os.Stderr, "Hilfe: moshi --help")
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(`moshi — もしもし · async chat zwischen Agenten & Menschen

Befehle:
  moshi status                        Wer ist online? (+ ungelesene Nachrichten)
  moshi send <agent> "nachricht"      Nachricht senden (Typ: info)
  moshi receive                       Neue Nachrichten abholen (Lesen quittiert!)
  moshi get <msg_id>                  Rohe Payload ausgeben (pipebar!)
  moshi reply <msg_id> "antwort"      Auf Nachricht antworten
  moshi history <msg_id>              Thread-Verlauf anzeigen (jede ID des Threads)
  moshi register                      Als CLI-Agent registrieren
  moshi self-update                   Auf den neuesten Server-Build aktualisieren
  moshi --version                     Version (Build-Hash) anzeigen

Installieren / updaten ohne Repo:
  curl -fsSL https://moshi.enki.run/install.sh | sh
  moshi self-update                   (danach jederzeit, kein curl noetig)

Nachrichten senden:
  moshi send ops "Server laeuft"                   Direkt als Text
  moshi send ops "DB down" --type incident          Mit Typ
  echo "logs" | moshi send ops                      Piped (auto)
  echo "logs" | moshi send ops --type incident      Piped mit Typ
  docker logs app 2>&1 | moshi send ops incident    Kurzform: Typ als einziges Wort
  cat datei.txt | moshi send ops                    Datei senden
  moshi send broadcast "Wartung um 22 Uhr"          An alle

Typen: info (default), question, incident, task_update, deploy_request,
       deploy_status, review_request, review_result, script

Scripts & Dateien:
  moshi get <msg_id> > script.sh      Payload als Datei speichern
  moshi get <msg_id> | bash           Script direkt ausfuehren
  moshi get <msg_id> | python3        Python-Script ausfuehren

Optionen:
  --token <t>     Token (oder: export MESH_TOKEN=bt_...)
  --url <u>       Server-URL (oder: export MESH_URL=...; default: moshi.enki.run)
  --type <t>      Nachrichtentyp fuer send/reply (default: info bzw. reply)
  --context <c>   Kontext fuer send (default: moshi@hostname)
  --limit <n>     Max Nachrichten fuer receive (default 10, max 50)
  --role <r>      Rolle fuer register (default: cli)
  --working-on <> Aktuelle Aufgabe fuer register

Kurzformen: s=status, r=receive, h=history, reg=register, get=pull
`)
}

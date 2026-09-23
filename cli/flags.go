package main

import (
	"fmt"
	"sort"
	"strings"
)

// The one argument parser of every command.
//
// A command names the flags it knows; they are taken out with their value,
// and everything else is the payload, in order. A token that looks like a
// flag ("--word") and is unknown is refused: it used to land in the payload,
// and `moshi reply <id> "text" --context x` delivered "text --context x".
// "--" ends the flags, so a payload that begins with "--" can still be sent.
// "-" (stdin), "-5" and "a--b" are text.
type parsed struct {
	flags map[string]string
	rest  []string
}

func parseArgs(args []string, known []string) (parsed, error) {
	isKnown := func(name string) bool {
		for _, k := range known {
			if k == name {
				return true
			}
		}
		return false
	}
	out := parsed{flags: map[string]string{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out.rest = append(out.rest, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") || len(a) == 2 {
			out.rest = append(out.rest, a)
			continue
		}
		name, value, hasValue := strings.Cut(a[2:], "=")
		if !isKnown(name) {
			names := append([]string(nil), known...)
			sort.Strings(names)
			for i := range names {
				names[i] = "--" + names[i]
			}
			return parsed{}, fmt.Errorf("unknown flag %s (this command knows: %s). Put \"--\" before a message that begins with --", a, strings.Join(names, ", "))
		}
		if !hasValue {
			if i+1 >= len(args) {
				return parsed{}, fmt.Errorf("%s needs a value", a)
			}
			value = args[i+1]
			i++
		}
		out.flags[name] = value
	}
	return out, nil
}

// The two flags every command shares. They are taken off argv before a
// command sees it, so they need the same "--" rule as parseArgs — and for
// the same reason, only worse: these two name the server and carry the
// bearer token.
//
// The scan used to run over EVERY argument and knew nothing about "--", so
// `moshi send ops -- $MSG` with a message that contained "--url http://evil"
// sent the real token to that host, printed "✓ Sent to ops" and exited 0.
// "--token" the same way, under an identity the sender did not choose. A
// wrapper that forwards words it did not write — a ticket body, a log line,
// an agent relaying text — was enough.
//
// Everything from "--" on is handed to the command untouched, including the
// "--" itself: parseArgs strips it there.
type globals struct {
	url   string
	token string
	rest  []string
}

func parseGlobals(args []string, envToken string) (globals, error) {
	out := globals{token: envToken}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			out.rest = append(out.rest, args[i:]...)
			return out, nil
		}
		key, val, eq := strings.Cut(a, "=")
		if key != "--url" && key != "--token" {
			out.rest = append(out.rest, a)
			continue
		}
		if !eq {
			if i+1 >= len(args) {
				if key == "--url" {
					return globals{}, fmt.Errorf("--url needs a value, e.g. --url https://mesh.example.com")
				}
				return globals{}, fmt.Errorf("--token needs a value, e.g. --token bt_...")
			}
			val = args[i+1]
			i++
		}
		if key == "--url" {
			out.url = val
		} else {
			out.token = val
		}
	}
	return out, nil
}

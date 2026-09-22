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

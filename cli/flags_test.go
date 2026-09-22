package main

import (
	"reflect"
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

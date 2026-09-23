package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Where the server is: the flag, the environment, then the file install.sh
// wrote. There is no compiled-in host any more: a self-hoster whose MESH_URL
// was missing sent their token to moshi.enki.run.

func TestResolveURLPrecedence(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	if err := os.WriteFile(file, []byte(`{"url":"https://from.file/mcp"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := resolveURL("https://flag.example", "https://env.example", file); got != "https://flag.example/mcp" {
		t.Fatalf("flag: got %q", got)
	}
	if got, _ := resolveURL("", "https://env.example/mcp", file); got != "https://env.example/mcp" {
		t.Fatalf("env: got %q", got)
	}
	if got, _ := resolveURL("", "", file); got != "https://from.file/mcp" {
		t.Fatalf("file: got %q", got)
	}
}

func TestResolveURLWithNothingConfiguredIsAnError(t *testing.T) {
	got, err := resolveURL("", "", filepath.Join(t.TempDir(), "none.json"))
	if err == nil || got != "" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, want := range []string{"MESH_URL", "--url", "install.sh"} {
		if !contains(err.Error(), want) {
			t.Errorf("the error should mention %s: %v", want, err)
		}
	}
}

func TestResolveURLIgnoresAFileItCannotRead(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "config.json")
	_ = os.WriteFile(file, []byte(`{not json`), 0o600)
	if _, err := resolveURL("", "", file); err == nil {
		t.Fatal("a broken file is not a configured URL")
	}
	_ = os.WriteFile(file, []byte(`{"url": 42}`), 0o600)
	if _, err := resolveURL("", "", file); err == nil {
		t.Fatal("a url that is no string is not a configured URL")
	}
}

func TestConfigPathHonoursXDGAndFallsBackToHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	if got := configPath(); got != filepath.Join("/tmp/xdg", "moshi", "config.json") {
		t.Fatalf("got %q", got)
	}
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/tmp/home")
	if got := configPath(); got != filepath.Join("/tmp/home", ".config", "moshi", "config.json") {
		t.Fatalf("got %q", got)
	}
}

// The XDG spec says a relative XDG_CONFIG_HOME must be ignored. It was
// joined as it came, so the working directory decided which server the
// bearer token went to: from one directory the CLI talked to the server a
// ./relcfg/moshi/config.json named, from another it said none was configured.
func TestConfigPathIgnoresARelativeXDGConfigHome(t *testing.T) {
	for _, rel := range []string{"relcfg", "./relcfg", "../relcfg", "a/b"} {
		t.Setenv("XDG_CONFIG_HOME", rel)
		got := configPath()
		if got != "" && !filepath.IsAbs(got) {
			t.Fatalf("XDG_CONFIG_HOME=%q gave the relative path %q", rel, got)
		}
		if strings.Contains(got, "relcfg") {
			t.Fatalf("XDG_CONFIG_HOME=%q was used anyway: %q", rel, got)
		}
	}
	abs := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", abs)
	if got := configPath(); got != filepath.Join(abs, "moshi", "config.json") {
		t.Fatalf("an absolute one was not used: %q", got)
	}
}

// baseURL is called while the CLI is printing help. It used to exit there.
func TestBaseURLDoesNotEndTheProcessOnANonURL(t *testing.T) {
	for _, in := range []string{"moshi.example", "", "://x", "not a url"} {
		if got := baseURL(in); got != in {
			t.Fatalf("baseURL(%q) = %q, want it handed back unchanged", in, got)
		}
	}
	if got := baseURL("https://moshi.example/mcp"); got != "https://moshi.example" {
		t.Fatalf("baseURL = %q", got)
	}
}

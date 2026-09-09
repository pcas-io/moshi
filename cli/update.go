package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// ── Version / self-update ───────────────────────────────────────
// Identity is the SHA-256 of the binary itself — no build-time version
// plumbing needed. The server serves the current binaries and reports
// their hashes at /cli/version, so "am I up to date?" is just a hash
// compare against the build the server ships.

func selfSHA256() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	f, err := os.Open(exe)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func platformKey() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// baseURL strips the /mcp path off the configured server URL.
func baseURL(mcpURL string) string {
	u, err := url.Parse(mcpURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		fatal("Ungueltige Server-URL: %s", mcpURL)
	}
	return u.Scheme + "://" + u.Host
}

func printVersion() {
	sha, err := selfSHA256()
	if err != nil {
		fmt.Printf("moshi %s (sha: n/a: %v)\n", platformKey(), err)
		return
	}
	fmt.Printf("moshi %s build %s\n", platformKey(), sha[:12])
}

func cmdSelfUpdate(mcpURL string) {
	base := baseURL(mcpURL)
	self, err := selfSHA256()
	if err != nil {
		fatal("Eigene Binary nicht lesbar: %v", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(base + "/cli/version")
	if err != nil {
		fatal("Server nicht erreichbar (%s/cli/version): %v", base, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fatal("Versionsabfrage fehlgeschlagen: HTTP %d", resp.StatusCode)
	}
	var vr struct {
		Platforms map[string]string `json:"platforms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&vr); err != nil {
		fatal("Versionsantwort nicht lesbar: %v", err)
	}

	key := platformKey()
	want, ok := vr.Platforms[key]
	if !ok || want == "" {
		fatal("Server bietet kein Build fuer %s", key)
	}
	if want == self {
		fmt.Printf("✓ Bereits aktuell (%s, build %s)\n", key, self[:12])
		return
	}

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	asset := fmt.Sprintf("%s/cli/moshi-%s%s", base, key, ext)
	fmt.Printf("↓ Update %s → %s …\n", self[:12], want[:12])

	dresp, err := client.Get(asset)
	if err != nil {
		fatal("Download fehlgeschlagen (%s): %v", asset, err)
	}
	defer dresp.Body.Close()
	if dresp.StatusCode != 200 {
		fatal("Download fehlgeschlagen: HTTP %d", dresp.StatusCode)
	}
	data, err := io.ReadAll(dresp.Body)
	if err != nil {
		fatal("Download-Stream-Fehler: %v", err)
	}

	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != want {
		fatal("Integritaetspruefung fehlgeschlagen — heruntergeladene Binary entspricht nicht dem Server-Hash. Abbruch.")
	}

	exe, err := os.Executable()
	if err != nil {
		fatal("Eigener Pfad nicht bestimmbar: %v", err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)
	tmp := filepath.Join(dir, ".moshi.update.tmp")
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		fatal("Schreiben fehlgeschlagen (%s): %v — Rechte? Versuche sudo oder MOSHI_BIN_DIR.", tmp, err)
	}

	if runtime.GOOS == "windows" {
		// Windows kann die laufende .exe nicht ueberschreiben — wegrenamen,
		// dann die neue an ihren Platz.
		_ = os.Remove(exe + ".old")
		if err := os.Rename(exe, exe+".old"); err != nil {
			_ = os.Remove(tmp)
			fatal("Rename der alten Binary fehlgeschlagen: %v", err)
		}
		if err := os.Rename(tmp, exe); err != nil {
			fatal("Installation fehlgeschlagen: %v (alte unter %s.old)", err, exe)
		}
	} else {
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Remove(tmp)
			fatal("Atomarer Replace fehlgeschlagen (%s): %v — Rechte?", exe, err)
		}
	}
	fmt.Printf("✓ Aktualisiert: %s (build %s)\n", exe, want[:12])
}

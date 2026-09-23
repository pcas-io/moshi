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
	"strings"
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
// Never fatal: its callers are printing help when they call it. A URL with
// no scheme used to end the process halfway through the "no token" message,
// after the two options and before the line that says where to get one, with
// an error naming the wrong problem.
func baseURL(mcpURL string) string {
	u, err := url.Parse(mcpURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return mcpURL
	}
	return u.Scheme + "://" + u.Host
}

// A binary is fetched over https, or over http from this machine only. Hash
// and binary come from the same server, so a plain-http update from anywhere
// else would take both from whoever sits on the wire.
//
// This is a check on the SCHEME, not on the host: an https server may still
// redirect to another https host, and that is on purpose — the promise is
// "https only", not "this host only". What it does rule out is the hop that
// leaves the encrypted transport.
func secureURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%s is not a URL with a scheme and a host; use https://your.server", raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return nil
	case "http":
		host := strings.ToLower(u.Hostname())
		if u.User == nil && (host == "localhost" || host == "127.0.0.1" || host == "::1") {
			return nil
		}
		return fmt.Errorf("%s: updates over plain http are refused (only https, or http to localhost)", raw)
	default:
		return fmt.Errorf("%s: updates are fetched over https only", raw)
	}
}

// A CLI binary is a few megabytes. Nothing larger is read, whatever the
// server says, and a Content-Length that says so is refused before a byte.
const maxBinaryBytes = 64 << 20

func fetchBounded(client *http.Client, asset string, maxBytes int64) ([]byte, error) {
	resp, err := client.Get(asset)
	if err != nil {
		return nil, fmt.Errorf("Download failed (%s): %v", asset, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Download failed: HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > maxBytes {
		return nil, fmt.Errorf("Download refused: the server offers %d bytes, larger than the %d MB a moshi binary can be", resp.ContentLength, maxBytes>>20)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("Download stream error: %v", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("Download refused: more than %d MB, larger than a moshi binary can be", maxBytes>>20)
	}
	return data, nil
}

// verifiedDownload fetches the asset and refuses it unless its SHA-256 is `want`.
func verifiedDownload(client *http.Client, asset, want string) ([]byte, error) {
	data, err := fetchBounded(client, asset, maxBinaryBytes)
	if err != nil {
		return nil, err
	}
	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != want {
		return nil, fmt.Errorf("Integrity check failed — the downloaded binary does not match the server hash. Aborting.")
	}
	return data, nil
}

// secureURL guards the URL that was configured. Without this, nothing guards
// the ones the server names afterwards: Go follows up to ten redirects to any
// host and any scheme by default, https to http included. A redirect on
// /cli/version and one on the binary moved BOTH onto plain http, where the
// integrity check then compared the attacker's bytes against the attacker's
// hash and passed. The transport has to hold for every hop, not just the
// first one.
func secureRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return fmt.Errorf("too many redirects")
	}
	return secureURL(req.URL.String())
}

type updatePlan struct {
	upToDate bool
	want     string
	asset    string
}

// planUpdate asks the server which build it ships for this platform.
func planUpdate(mcpURL, self string) (updatePlan, error) {
	if err := secureURL(mcpURL); err != nil {
		return updatePlan{}, err
	}
	base := baseURL(mcpURL)
	client := &http.Client{Timeout: 60 * time.Second, CheckRedirect: secureRedirect}
	resp, err := client.Get(base + "/cli/version")
	if err != nil {
		return updatePlan{}, fmt.Errorf("Cannot reach the server (%s/cli/version): %v", base, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return updatePlan{}, fmt.Errorf("Version lookup failed: HTTP %d", resp.StatusCode)
	}
	var vr struct {
		Platforms map[string]string `json:"platforms"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&vr); err != nil {
		return updatePlan{}, fmt.Errorf("Could not parse the version response: %v", err)
	}
	key := platformKey()
	want, ok := vr.Platforms[key]
	if !ok || len(want) != 64 {
		return updatePlan{}, fmt.Errorf("The server has no build for %s", key)
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return updatePlan{upToDate: want == self, want: want, asset: fmt.Sprintf("%s/cli/moshi-%s%s", base, key, ext)}, nil
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
	self, err := selfSHA256()
	if err != nil {
		fatal("Cannot read my own binary: %v", err)
	}
	plan, err := planUpdate(mcpURL, self)
	if err != nil {
		fatal("%v", err)
	}
	if plan.upToDate {
		fmt.Printf("✓ Already up to date (%s, build %s)\n", platformKey(), self[:12])
		return
	}
	fmt.Printf("↓ Updating %s → %s …\n", self[:12], plan.want[:12])
	data, err := verifiedDownload(
		&http.Client{Timeout: 5 * time.Minute, CheckRedirect: secureRedirect},
		plan.asset, plan.want,
	)
	if err != nil {
		fatal("%v", err)
	}
	want := plan.want

	exe, err := os.Executable()
	if err != nil {
		fatal("Cannot determine my own path: %v", err)
	}
	exe, _ = filepath.EvalSymlinks(exe)
	dir := filepath.Dir(exe)
	tmp := filepath.Join(dir, ".moshi.update.tmp")
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		fatal("Write failed (%s): %v — permissions? Try sudo or MOSHI_BIN_DIR.", tmp, err)
	}

	if runtime.GOOS == "windows" {
		// Windows cannot overwrite the running .exe — rename it away,
		// then move the new one into place.
		_ = os.Remove(exe + ".old")
		if err := os.Rename(exe, exe+".old"); err != nil {
			_ = os.Remove(tmp)
			fatal("Renaming the old binary failed: %v", err)
		}
		if err := os.Rename(tmp, exe); err != nil {
			fatal("Install failed: %v (the old binary is at %s.old)", err, exe)
		}
	} else {
		if err := os.Rename(tmp, exe); err != nil {
			_ = os.Remove(tmp)
			fatal("Atomic replace failed (%s): %v — permissions?", exe, err)
		}
	}
	fmt.Printf("✓ Updated: %s (build %s)\n", exe, want[:12])
}

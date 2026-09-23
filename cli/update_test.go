package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The update checks integrity, not origin: hash and binary come from the
// same server. What can be had cheaply: no update over plain http to
// anything but this machine, no download without a bound, and no token to a
// host nobody configured.

func TestSecureURLAllowsHTTPSAndLoopbackHTTPOnly(t *testing.T) {
	for _, ok := range []string{"https://moshi.example/mcp", "http://localhost:8080/mcp", "http://127.0.0.1:8080/mcp", "http://[::1]:8080/mcp", "HTTP://LOCALHOST/mcp"} {
		if err := secureURL(ok); err != nil {
			t.Errorf("%s should be allowed: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://moshi.example/mcp", "http://localhost.evil.example/mcp", "http://192.168.1.5/mcp", "http://10.0.0.1:8080/mcp", "ftp://moshi.example/mcp", "moshi.example/mcp", "http://localhost@evil.example/mcp"} {
		err := secureURL(bad)
		if err == nil {
			t.Errorf("%s should be refused", bad)
		} else if !strings.Contains(err.Error(), "https") {
			t.Errorf("%s: the error should say https, got %v", bad, err)
		}
	}
}

func TestFetchBoundedRefusesABodyOverTheLimit(t *testing.T) {
	big := strings.Repeat("x", 3000)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(big)) }))
	defer srv.Close()
	if _, err := fetchBounded(srv.Client(), srv.URL+"/cli/moshi-linux-amd64", 2000); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("got %v", err)
	}
	data, err := fetchBounded(srv.Client(), srv.URL+"/cli/moshi-linux-amd64", 3000)
	if err != nil || len(data) != 3000 {
		t.Fatalf("got %d bytes, %v", len(data), err)
	}
}

func TestFetchBoundedRefusesAContentLengthOverTheLimitWithoutReading(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "99999999")
		w.WriteHeader(200)
	}))
	defer srv.Close()
	if _, err := fetchBounded(srv.Client(), srv.URL+"/x", 1000); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("got %v", err)
	}
}

func TestPlanUpdateRefusesAnHTTPServer(t *testing.T) {
	if _, err := planUpdate("http://moshi.example/mcp", "abc"); err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("got %v", err)
	}
}

func TestPlanUpdateUsesTheServersHashForThisPlatform(t *testing.T) {
	binary := []byte("the new binary")
	sum := sha256.Sum256(binary)
	want := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cli/version":
			_ = json.NewEncoder(w).Encode(map[string]any{"platforms": map[string]string{platformKey(): want}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	plan, err := planUpdate(srv.URL+"/mcp", "old")
	if err != nil {
		t.Fatal(err)
	}
	if plan.want != want || !strings.HasPrefix(plan.asset, srv.URL+"/cli/moshi-") {
		t.Fatalf("got %+v", plan)
	}
	same, err := planUpdate(srv.URL+"/mcp", want)
	if err != nil || !same.upToDate {
		t.Fatalf("got %+v, %v", same, err)
	}
}

func TestVerifiedDownloadRefusesABinaryThatDoesNotMatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("tampered")) }))
	defer srv.Close()
	sum := sha256.Sum256([]byte("the real one"))
	_, err := verifiedDownload(srv.Client(), srv.URL+"/cli/moshi-linux-amd64", hex.EncodeToString(sum[:]))
	if err == nil || !strings.Contains(err.Error(), "Integrity check failed") {
		t.Fatalf("got %v", err)
	}
}

// The hole this closes: secureURL ran once, on the configured URL, and Go's
// default policy then followed up to ten redirects to any host and any
// scheme. Both the hash and the binary could be moved onto plain http, where
// the integrity check compared the attacker's bytes against the attacker's
// hash and passed.
func TestPlanUpdateRefusesARedirectOffTheAllowedTransport(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://moshi.example/cli/version", http.StatusFound)
	}))
	defer srv.Close()
	_, err := planUpdate(srv.URL+"/mcp", "old")
	if err == nil || !strings.Contains(err.Error(), "https") {
		t.Fatalf("a redirect off https was followed: %v", err)
	}
}

func TestVerifiedDownloadRefusesARedirectOffTheAllowedTransport(t *testing.T) {
	binary := []byte("whatever the other host serves")
	sum := sha256.Sum256(binary)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://moshi.example/cli/moshi-linux-amd64", http.StatusFound)
	}))
	defer srv.Close()
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: secureRedirect}
	if _, err := verifiedDownload(client, srv.URL+"/cli/moshi-linux-amd64", hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("the binary was taken from a plain-http host")
	}
}

// The guard is on the scheme, not on the host: a server may serve its
// binaries from somewhere else as long as the transport holds.
func TestPlanUpdateFollowsARedirectThatKeepsTheTransport(t *testing.T) {
	want := hex.EncodeToString(func() []byte { s := sha256.Sum256([]byte("x")); return s[:] }())
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"platforms": map[string]string{platformKey(): want}})
	}))
	defer elsewhere.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/cli/version", http.StatusFound)
	}))
	defer srv.Close()
	plan, err := planUpdate(srv.URL+"/mcp", "old")
	if err != nil {
		t.Fatalf("a loopback-to-loopback redirect was refused: %v", err)
	}
	if plan.want != want {
		t.Fatalf("got %+v", plan)
	}
}

func TestSecureRedirectStopsAChain(t *testing.T) {
	hops := 0
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hops++
		http.Redirect(w, r, srv.URL+"/cli/version", http.StatusFound)
	}))
	defer srv.Close()
	if _, err := planUpdate(srv.URL+"/mcp", "old"); err == nil {
		t.Fatal("an endless redirect chain was followed to the end")
	}
	if hops > 6 {
		t.Fatalf("followed %d hops", hops)
	}
}

// Neither a failed version lookup nor a failed download may end in an
// update: both were untested, and a mutant that dropped the status check
// survived.
func TestPlanUpdateRefusesANonOKVersionResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(503)
		_, _ = w.Write([]byte(`{"platforms":{}}`))
	}))
	defer srv.Close()
	_, err := planUpdate(srv.URL+"/mcp", "old")
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("got %v", err)
	}
}

func TestVerifiedDownloadRefusesANonOKAsset(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
	}))
	defer srv.Close()
	sum := sha256.Sum256(nil)
	if _, err := verifiedDownload(srv.Client(), srv.URL+"/cli/moshi-linux-amd64", hex.EncodeToString(sum[:])); err == nil {
		t.Fatal("a 404 body was accepted as a binary")
	}
}

func TestVerifiedDownloadReturnsTheBytesThatMatch(t *testing.T) {
	binary := []byte("the real one")
	sum := sha256.Sum256(binary)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(binary)
	}))
	defer srv.Close()
	got, err := verifiedDownload(srv.Client(), srv.URL+"/cli/moshi-linux-amd64", hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(binary) {
		t.Fatalf("got %q", got)
	}
}

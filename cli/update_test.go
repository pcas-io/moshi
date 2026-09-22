package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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

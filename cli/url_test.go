package main

import "testing"

// MESH_URL without a path is the server, and the endpoint is /mcp. Any other
// path is what the user meant. It used to be sent as it was, and the server
// answered the dashboard's sign-in redirect to a JSON client.
func TestNormalizeMCPURLAddsTheEndpointToABareOrigin(t *testing.T) {
	cases := map[string]string{
		"https://moshi.example":         "https://moshi.example/mcp",
		"https://moshi.example/":        "https://moshi.example/mcp",
		"http://localhost:8080":         "http://localhost:8080/mcp",
		"http://localhost:8080/":        "http://localhost:8080/mcp",
		"https://moshi.example/mcp":     "https://moshi.example/mcp",
		"https://moshi.example/mcp/":    "https://moshi.example/mcp/",
		"https://moshi.example/other":   "https://moshi.example/other",
		"https://moshi.example?x=1":     "https://moshi.example/mcp?x=1",
		"  https://moshi.example/mcp  ": "https://moshi.example/mcp",
		"moshi.example":                 "moshi.example",
	}
	for in, want := range cases {
		if got := normalizeMCPURL(in); got != want {
			t.Errorf("normalizeMCPURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBaseURLStripsTheEndpoint(t *testing.T) {
	if got := baseURL("https://moshi.example/mcp"); got != "https://moshi.example" {
		t.Fatalf("got %q", got)
	}
}

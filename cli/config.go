package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// Where the server is. In this order: --url, MESH_URL, and the file that
// install.sh wrote when it fetched the binary from that very server. There
// is no compiled-in host any more: a self-hoster whose MESH_URL was missing
// sent their token to moshi.enki.run without a word.

// configPath: $XDG_CONFIG_HOME/moshi/config.json, else ~/.config/moshi/config.json
// (on Windows %APPDATA%\moshi\config.json). install.sh and install.ps1 write
// the same file.
func configPath() string {
	// The XDG spec: a value that is not absolute must be ignored. It was
	// joined as it came, so `XDG_CONFIG_HOME=relcfg moshi status` read
	// ./relcfg/moshi/config.json — same binary, same environment, and the
	// working directory decided which server got the bearer token.
	if xdg := os.Getenv("XDG_CONFIG_HOME"); filepath.IsAbs(xdg) {
		return filepath.Join(xdg, "moshi", "config.json")
	}
	if runtime.GOOS == "windows" {
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "moshi", "config.json")
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "moshi", "config.json")
}

type configFile struct {
	URL string `json:"url"`
}

func resolveURL(flag, env, file string) (string, error) {
	if flag != "" {
		return normalizeMCPURL(flag), nil
	}
	if env != "" {
		return normalizeMCPURL(env), nil
	}
	if file != "" {
		if data, err := os.ReadFile(file); err == nil {
			var cfg configFile
			if json.Unmarshal(data, &cfg) == nil && cfg.URL != "" {
				return normalizeMCPURL(cfg.URL), nil
			}
		}
	}
	return "", errors.New("No server configured.\n\n" +
		"  Option 1: export MESH_URL=https://your.moshi.server\n" +
		"  Option 2: moshi --url https://your.moshi.server status\n" +
		"  Option 3: install with  curl -fsSL https://your.moshi.server/install.sh | sh\n" +
		"            which remembers the server in " + configPath())
}

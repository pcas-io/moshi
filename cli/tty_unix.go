//go:build !windows

package main

import "os"

// isTTY reports whether stdout is attached to a terminal on Unix systems.
// Pipes, redirects and non-terminal devices return false so ANSI escape
// sequences don't leak into captured output.
func isTTY() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// stdinHasData reports whether stdin is piped (has data), not a terminal.
func stdinHasData() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice == 0
}

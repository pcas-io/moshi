//go:build windows

package main

import "os"

// isTTY on Windows is conservative: we only enable ANSI escape sequences
// when we can detect a terminal that is known to render them correctly.
//
// Modern detection (no extra deps — we stay on Go stdlib only):
//   - Windows Terminal sets WT_SESSION on every pane.
//   - ConEmu sets ANSICON.
//   - PowerShell 7+ in a compatible host inherits WT_SESSION when run
//     under Windows Terminal.
//
// cmd.exe without any of these is treated as non-TTY, so we print plain
// text instead of raw escape sequences. Users who want color in that
// shell can launch from Windows Terminal or ConEmu.
func isTTY() bool {
	// First: must actually be attached to a character device
	// (pipes/redirects always suppress ANSI output).
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	if fi.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	// Then: only enable ANSI if the terminal is known to support it.
	if os.Getenv("WT_SESSION") != "" {
		return true
	}
	if os.Getenv("ANSICON") != "" {
		return true
	}
	return false
}

// stdinHasData reports whether stdin is piped (has data), not a terminal.
// Same semantics as the unix version — os.ModeCharDevice is cross-platform.
func stdinHasData() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice == 0
}

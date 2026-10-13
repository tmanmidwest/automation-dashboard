//go:build !linux

package main

import "fmt"

// Remote Desktop auto-setup is Linux-only in P1. Windows and macOS already expose a native
// remote desktop (RDP / Screen Sharing), so use the existing RDP/VNC connect for those —
// no agent-side enabling needed.
func startDesktop(_, _, _ string) (string, int, error) {
	return "", 0, fmt.Errorf("one-click Remote Desktop setup is Linux-only for now; on this OS use the existing RDP or VNC connection")
}

func stopDesktop() error { return nil }

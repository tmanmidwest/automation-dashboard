//go:build !linux

package main

import "fmt"

// Remote Desktop auto-setup is Linux-only. Windows and macOS already expose a native remote
// desktop (RDP / Screen Sharing), so use the existing RDP/VNC connect for those — no
// agent-side enabling needed. The bundled virtual desktop (P2) is likewise Linux-only.
func startDesktop(_, _, _, _ string, _, _ int) (desktopResult, error) {
	return desktopResult{}, fmt.Errorf("one-click Remote Desktop setup is Linux-only; on this OS use the existing RDP or VNC connection")
}

func stopDesktop(_ string) error { return nil }

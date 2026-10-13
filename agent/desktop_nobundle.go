//go:build linux && !bundledesktop

package main

// Default Linux build: no virtual-desktop binaries embedded. The agent uses the host's own
// VNC server (if installed) for the headless fallback. To ship a self-contained virtual
// desktop, build the agent with `-tags bundledesktop` after placing the native binaries under
// agent/desktop/linux_<arch>/ (see agent/desktop/README.md); desktop_bundle.go then embeds
// and extracts them.
func bundledDesktopDir() (string, bool) { return "", false }

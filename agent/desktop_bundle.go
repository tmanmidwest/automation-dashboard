//go:build linux && bundledesktop

package main

// Self-contained virtual desktop: the native binaries (TigerVNC Xvnc + vncpasswd + a WM like
// openbox, plus any libs/fonts they need) are embedded in the agent and extracted on first
// use. Build with `-tags bundledesktop` AFTER placing them under agent/desktop/linux_<arch>/
// per architecture (they are NOT in the repo — see agent/desktop/README.md). Expect the agent
// binary to grow by tens of MB. The embedded executables (TigerVNC GPLv2 / openbox GPLv2) are
// invoked as separate processes, not linked.

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

//go:embed all:desktop
var desktopFS embed.FS

var (
	bundleOnce sync.Once
	bundlePath string
	bundleOK   bool
)

// bundledDesktopDir extracts the architecture-matching bundle to a private dir once and
// returns its path. On any problem it returns ("", false) so the caller falls back to the
// host's own VNC server.
func bundledDesktopDir() (string, bool) {
	bundleOnce.Do(func() {
		sub := "desktop/linux_" + runtime.GOARCH
		entries, err := fs.ReadDir(desktopFS, sub)
		if err != nil || len(entries) == 0 {
			log.Printf("virtual desktop: no embedded bundle for linux_%s (%v)", runtime.GOARCH, err)
			return
		}
		dir := filepath.Join(os.TempDir(), "cerebro-desktop-bin", runtime.GOARCH)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Printf("virtual desktop: cannot create bundle dir: %v", err)
			return
		}
		if err := extractTree(sub, dir); err != nil {
			log.Printf("virtual desktop: extracting bundle failed: %v", err)
			return
		}
		bundlePath, bundleOK = dir, true
	})
	return bundlePath, bundleOK
}

// extractTree copies the embedded subtree rooted at src into dst, flattening to dst and making
// regular files executable (they're binaries/scripts the desktop toolchain invokes).
func extractTree(src, dst string) error {
	return fs.WalkDir(desktopFS, src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(src, p)
		if rerr != nil {
			return rerr
		}
		out := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(out, 0o755)
		}
		b, rerr := desktopFS.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		return os.WriteFile(out, b, 0o755)
	})
}

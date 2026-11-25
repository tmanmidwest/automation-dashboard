//go:build linux

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestParseProcLocks(t *testing.T) {
	in := `1: POSIX  ADVISORY  WRITE 827701 fd:00:1835030 0 EOF
1: -> POSIX  ADVISORY  WRITE 900001 fd:00:1835030 0 EOF
2: OFDLCK ADVISORY  READ  -1 00:1a:12 0 EOF
3: FLOCK  ADVISORY  WRITE 1057 00:19:777 0 EOF
`
	got := parseProcLocks(in)
	if len(got) != 2 || got[0].pid != 827701 || got[0].inode != 1835030 || got[1].pid != 1057 || got[1].inode != 777 {
		t.Fatalf("got %+v", got)
	}
}

func TestParseStatStartTicks(t *testing.T) {
	// comm with spaces and a ')' in it; starttime (field 22) = 4242.
	s := "827701 (apt get) x) S 1 827701 827701 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 4242 1000 10 18446744073709551615"
	v, ok := parseStatStartTicks(s)
	if !ok || v != 4242 {
		t.Fatalf("got %d %v", v, ok)
	}
}

func TestFmtDuration(t *testing.T) {
	cases := map[time.Duration]string{
		20 * time.Second:             "under a minute",
		12 * time.Minute:             "12m",
		3*time.Hour + 12*time.Minute: "3h 12m",
		50*time.Hour + 5*time.Minute: "2d 2h",
	}
	for d, want := range cases {
		if got := fmtDuration(d); got != want {
			t.Errorf("%v: got %q want %q", d, got, want)
		}
	}
}

func TestStuckHolder(t *testing.T) {
	hs := []lockHolder{{PID: 1, Running: 5 * time.Minute}, {PID: 2, Running: 3 * time.Hour}}
	if h := stuckHolder(hs); h == nil || h.PID != 2 {
		t.Fatalf("got %+v", h)
	}
	if stuckHolder(hs[:1]) != nil {
		t.Fatal("5m shouldn't be stuck")
	}
}

func TestIsAptProcess(t *testing.T) {
	if !isAptProcess(lockHolder{Comm: "apt-get"}) || !isAptProcess(lockHolder{Comm: "python3", Command: "/usr/bin/python3 /usr/bin/unattended-upgrade"}) {
		t.Fatal("apt processes not recognised")
	}
	if isAptProcess(lockHolder{Comm: "bash", Command: "bash"}) {
		t.Fatal("bash is not apt")
	}
}

// A real POSIX lock held by another process shows up with its pid and command.
func TestLockHoldersOfRealLock(t *testing.T) {
	f := filepath.Join(t.TempDir(), "lock")
	if err := os.WriteFile(f, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not installed")
	}
	cmd := exec.Command(py, "-c", "import fcntl,sys,time; fd=open(sys.argv[1],'w'); fcntl.lockf(fd, fcntl.LOCK_EX); print('ok', flush=True); time.sleep(30)", f)
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	buf := make([]byte, 3)
	if _, err := out.Read(buf); err != nil {
		t.Fatal(err)
	}
	// Started by this test process, so it counts as our own child and is skipped…
	if hs := lockHoldersOf([]string{f}); len(hs) != 0 {
		t.Fatalf("own child should be skipped, got %+v", hs)
	}
	// …but descendants() finds it, which is what Repair stops.
	found := false
	for _, p := range descendants(os.Getpid()) {
		if p == cmd.Process.Pid {
			found = true
		}
	}
	if !found {
		t.Fatal("descendants() missed the child")
	}
}

// A lock held by a process this agent didn't start is reported, with how long it has run.
func TestLockHoldersOfForeignLock(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	dir := t.TempDir()
	f := filepath.Join(dir, "lock")
	ready := filepath.Join(dir, "ready")
	_ = os.WriteFile(f, nil, 0o600)
	script := "import fcntl,sys,time; fd=open(sys.argv[1],'w'); fcntl.lockf(fd, fcntl.LOCK_EX); open(sys.argv[2],'w').close(); time.sleep(20)"
	// The shell backgrounds python and exits, so python is re-parented away from us.
	if err := exec.Command("sh", "-c", `python3 -c "$0" "$1" "$2" >/dev/null 2>&1 &`, script, f, ready).Run(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50 && !fileExists(ready); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	hs := lockHoldersOf([]string{f})
	if len(hs) != 1 || hs[0].Comm != "python3" || hs[0].Lock != f {
		t.Fatalf("got %+v", hs)
	}
	if stopProcessTree(hs[0].PID, 5*time.Second, func(string) {}) != true {
		t.Fatal("couldn't stop the holder")
	}
	if left := lockHoldersOf([]string{f}); len(left) != 0 {
		t.Fatalf("lock still held: %+v", left)
	}
}

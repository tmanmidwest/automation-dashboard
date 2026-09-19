// Cerebro Fabric agent.
//
// A tiny, outbound-only agent for Linux/Windows boxes. It exchanges a one-time
// enrollment token for a long-lived credential, then holds a persistent
// WebSocket to Cerebro open (dialing OUT — no inbound firewall rule needed),
// announcing itself and heartbeating so the box shows up in Cerebro's /fabric
// inventory. Phase 1 carries identity + liveness only; RDP/SSH tunnels land in
// Phase 2. See docs/fabric-remote-access.md.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const agentVersion = "0.3.4"

// Keep in step with FABRIC_HEARTBEAT_MS in packages/shared/src/fabric.ts.
const heartbeatInterval = 15 * time.Second

// How often to re-probe local ports so a service enabled after connect (e.g. the
// operator turning on Screen Sharing) is announced without restarting the agent.
const targetProbeInterval = 60 * time.Second

type config struct {
	URL      string
	Enroll   string
	StateDir string
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	// runAgent is OS-specific: on Windows it runs under the Service Control
	// Manager when launched as a service; elsewhere it runs in the foreground.
	// Both call agentMain with a stop channel.
	runAgent()
}

// agentMain enrolls (if needed) then holds the reconnect loop until stop is
// closed (a service Stop) — or the process exits on an uninstall command.
func agentMain(stop <-chan struct{}) {
	cfg := loadConfig()
	if cfg.URL == "" {
		log.Print("CEREBRO_URL is not set (env or config.env).")
		return
	}
	cred, err := ensureCredential(cfg)
	if err != nil {
		log.Printf("enrollment failed: %v", err)
		return
	}
	log.Printf("cerebro-agent v%s starting; endpoint=%s", agentVersion, cfg.URL)

	backoff := time.Second
	for {
		select {
		case <-stop:
			return
		default:
		}
		if err := run(cfg, cred, stop); err != nil {
			log.Printf("connection ended: %v", err)
		}
		jitter := time.Duration(time.Now().UnixNano()%int64(time.Second)) / 2
		select {
		case <-stop:
			return
		case <-time.After(backoff + jitter):
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

// run holds one control connection open until it drops, then returns the error
// so main can reconnect with backoff. It carries both the control channel
// (JSON text frames) and the tunnel data plane (binary frames), multiplexed by
// a per-connection session.
func run(cfg config, cred string, stop <-chan struct{}) error {
	wsURL := toWS(cfg.URL) + "/api/fabric/agent/ws"
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cred)

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	conn, resp, err := dialer.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("dial %s: %s", wsURL, resp.Status)
		}
		return fmt.Errorf("dial %s: %w", wsURL, err)
	}
	defer conn.Close()
	log.Printf("connected to %s", wsURL)

	targets := detectTargets()
	sess := newSession(conn, allowSet(targets), cfg)
	defer sess.closeAll()

	writerDone := make(chan struct{})
	go sess.writeLoop(writerDone)

	sess.writeJSON(map[string]any{
		"t":            "hello",
		"agentVersion": agentVersion,
		"os":           runtime.GOOS,
		"osVersion":    osVersion(),
		"hostname":     hostname(),
		"targets":      targets,
	})

	// Reader goroutine: routes frames and surfaces the first read error.
	readErr := make(chan error, 1)
	go func() {
		for {
			mt, msg, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			if mt == websocket.BinaryMessage {
				sess.onData(msg)
			} else {
				sess.onControl(msg)
			}
		}
	}()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	probe := time.NewTicker(targetProbeInterval)
	defer probe.Stop()
	lastTargets := targetsSig(targets)
	for {
		select {
		case <-stop:
			sess.stop()
			<-writerDone
			return nil
		case err := <-readErr:
			sess.stop()
			<-writerDone
			return err
		case <-ticker.C:
			sess.writeJSON(map[string]string{"t": "heartbeat"})
		case d := <-sess.hbReset:
			// Broker asked for a different heartbeat cadence — adopt it live.
			log.Printf("heartbeat cadence set to %s by broker", d)
			ticker.Reset(d)
		case <-probe.C:
			// Re-announce only when the reachable set actually changed. The allow-list
			// already covers loopback 22/3389/5900 (the ports detectTargets probes), so
			// no allow-list update is needed for the broker to dial a new target.
			cur := detectTargets()
			if sig := targetsSig(cur); sig != lastTargets {
				lastTargets = sig
				log.Printf("local targets changed — re-announcing (%s)", sig)
				sess.writeJSON(map[string]any{"t": "targets", "targets": cur})
			}
		}
	}
}

// installCA installs an SSH CA public key into the host's sshd trust (best-effort,
// OS-specific), reports the outcome, and — on success — offers the box's host key
// for a host certificate so clients can verify the host via the CA.
func (s *session) installCA(caPub string) {
	err := configureSshdTrustCA(strings.TrimSpace(caPub))
	if err != nil {
		log.Printf("install-ca failed: %v", err)
		s.writeJSON(map[string]any{"t": "ca-result", "ok": false, "error": err.Error()})
		return
	}
	log.Print("installed SSH CA into sshd trust")
	s.writeJSON(map[string]any{"t": "ca-result", "ok": true})

	if pub, keyType, herr := readHostKey(); herr == nil {
		s.writeJSON(map[string]any{"t": "host-key", "publicKey": pub, "keyType": keyType})
	} else {
		log.Printf("no host key to certify: %v", herr)
	}
}

// installHostCert writes a broker-signed host certificate and points sshd at it
// (HostCertificate), validating before reload and reverting on failure.
func (s *session) installHostCert(cert, keyType string) {
	if err := installHostCertFile(strings.TrimSpace(cert), keyType); err != nil {
		log.Printf("install host-cert failed: %v", err)
		return
	}
	log.Print("installed SSH host certificate")
}

// readHostKey returns the box's preferred SSH host public key + its type.
func readHostKey() (pub string, keyType string, err error) {
	for _, kt := range []string{"ed25519", "ecdsa", "rsa"} {
		if b, e := os.ReadFile(sshHostKeyBase(kt) + ".pub"); e == nil {
			return strings.TrimSpace(string(b)), kt, nil
		}
	}
	return "", "", fmt.Errorf("no host public key found")
}

// installHostCertFile writes <hostkey>-cert.pub and ensures a HostCertificate line
// in sshd_config; validates with sshd -t and reverts on failure, then reloads.
func installHostCertFile(cert, keyType string) error {
	if cert == "" {
		return fmt.Errorf("empty certificate")
	}
	certPath := sshHostKeyBase(keyType) + "-cert.pub"
	if err := os.WriteFile(certPath, []byte(cert+"\n"), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", certPath, err)
	}
	cfg := sshdConfigPath()
	backup, err := os.ReadFile(cfg)
	if err != nil {
		return fmt.Errorf("read %s: %w", cfg, err)
	}
	if _, err := ensureLineInFile(cfg, hostCertLine(certPath)); err != nil {
		return fmt.Errorf("edit %s: %w", cfg, err)
	}
	if err := validateSshd(); err != nil {
		_ = os.WriteFile(cfg, backup, 0o644)
		return fmt.Errorf("sshd config invalid, reverted: %w", err)
	}
	reloadSshd()
	return nil
}

// ensureLineInFile appends `line` to the file if an exact-line match is absent.
// Returns whether it changed the file.
func ensureLineInFile(path, line string) (bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	for _, existing := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(existing) == line {
			return false, nil
		}
	}
	content := string(b)
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += line + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// targetsSig is an order-independent signature of a target set, for change detection.
func targetsSig(ts []target) string {
	keys := make([]string, 0, len(ts))
	for _, t := range ts {
		keys = append(keys, fmt.Sprintf("%s/%s:%d", t.Kind, t.Host, t.Port))
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

// --- Tunnel multiplexer ----------------------------------------------------
//
// gorilla/websocket forbids concurrent writers, so every outbound frame (hello,
// heartbeats, stream control, and stream data from any goroutine) is funnelled
// through one buffered channel drained by a single writeLoop. A full channel
// blocks the producer, which is the backpressure signal for a slow tunnel.

type outMsg struct {
	mt   int
	data []byte
}

type session struct {
	conn     *websocket.Conn
	allow    map[string]bool
	cfg      config
	out      chan outMsg
	quit     chan struct{}
	quitOnce sync.Once
	mu       sync.Mutex
	streams  map[uint32]net.Conn
	// hbReset carries a new heartbeat cadence from a hello-ack to the run loop.
	hbReset chan time.Duration
}

func newSession(conn *websocket.Conn, allow map[string]bool, cfg config) *session {
	return &session{
		conn:    conn,
		allow:   allow,
		cfg:     cfg,
		out:     make(chan outMsg, 128),
		quit:    make(chan struct{}),
		streams: map[uint32]net.Conn{},
		hbReset: make(chan time.Duration, 1),
	}
}

func (s *session) writeLoop(done chan struct{}) {
	defer close(done)
	for {
		select {
		case <-s.quit:
			return
		case m := <-s.out:
			_ = s.conn.SetWriteDeadline(time.Now().Add(20 * time.Second))
			if err := s.conn.WriteMessage(m.mt, m.data); err != nil {
				s.stop()
				return
			}
		}
	}
}

func (s *session) stop() { s.quitOnce.Do(func() { close(s.quit) }) }

// enqueue blocks the caller until the frame is buffered or the session stops —
// providing per-stream backpressure rather than dropping bytes.
func (s *session) enqueue(m outMsg) {
	select {
	case <-s.quit:
	case s.out <- m:
	}
}

func (s *session) writeJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.enqueue(outMsg{websocket.TextMessage, b})
}

func (s *session) writeBinary(b []byte) { s.enqueue(outMsg{websocket.BinaryMessage, b}) }

type ctrlFrame struct {
	T                  string `json:"t"`
	StreamID           uint32 `json:"streamId"`
	Host               string `json:"host"`
	Port               int    `json:"port"`
	LatestAgentVersion string `json:"latestAgentVersion"`
	HeartbeatMs        int64  `json:"heartbeatMs"`
	CaPublicKey        string `json:"caPublicKey"`
	Certificate        string `json:"certificate"`
	KeyType            string `json:"keyType"`
}

func (s *session) onControl(msg []byte) {
	var c ctrlFrame
	if err := json.Unmarshal(msg, &c); err != nil {
		return
	}
	switch c.T {
	case "open-stream":
		go s.openStream(c.StreamID, c.Host, c.Port)
	case "close-stream":
		s.closeStream(c.StreamID, false)
	case "uninstall":
		log.Print("received uninstall command from Cerebro — removing this agent")
		selfUninstall() // OS-specific; spawns a detached remover and exits
	case "install-ca":
		go s.installCA(c.CaPublicKey)
	case "host-cert":
		go s.installHostCert(c.Certificate, c.KeyType)
	case "hello-ack":
		if c.LatestAgentVersion != "" && versionLess(agentVersion, c.LatestAgentVersion) && !autoUpdateDisabled() {
			log.Printf("agent %s available (have %s) — self-updating", c.LatestAgentVersion, agentVersion)
			go trySelfUpdate(s.cfg)
		}
		// Adopt the broker's heartbeat cadence (operator-tunable, FABRIC_HEARTBEAT_MS).
		if c.HeartbeatMs >= 1000 {
			select {
			case s.hbReset <- time.Duration(c.HeartbeatMs) * time.Millisecond:
			default:
			}
		}
	case "ping":
		// no action
	}
}

func (s *session) onData(msg []byte) {
	if len(msg) < 4 {
		return
	}
	id := binary.BigEndian.Uint32(msg[:4])
	s.mu.Lock()
	local := s.streams[id]
	s.mu.Unlock()
	if local == nil {
		return
	}
	if _, err := local.Write(msg[4:]); err != nil {
		s.closeStream(id, true)
	}
}

func (s *session) openStream(id uint32, host string, port int) {
	key := fmt.Sprintf("%s:%d", host, port)
	if !s.allow[key] {
		s.writeJSON(map[string]any{"t": "stream-error", "streamId": id, "error": "target not allowed"})
		return
	}
	local, err := net.DialTimeout("tcp", key, 5*time.Second)
	if err != nil {
		s.writeJSON(map[string]any{"t": "stream-error", "streamId": id, "error": err.Error()})
		return
	}
	s.mu.Lock()
	s.streams[id] = local
	s.mu.Unlock()
	s.writeJSON(map[string]any{"t": "stream-opened", "streamId": id})
	go s.pumpLocalToWS(id, local)
}

func (s *session) pumpLocalToWS(id uint32, local net.Conn) {
	buf := make([]byte, 32*1024)
	for {
		n, err := local.Read(buf)
		if n > 0 {
			frame := make([]byte, 4+n)
			binary.BigEndian.PutUint32(frame, id)
			copy(frame[4:], buf[:n])
			s.writeBinary(frame)
		}
		if err != nil {
			s.closeStream(id, true)
			return
		}
	}
}

// closeStream tears down a stream. notifyPeer sends close-stream to the broker;
// the guard on `local` ensures we only notify once even under concurrent close.
func (s *session) closeStream(id uint32, notifyPeer bool) {
	s.mu.Lock()
	local := s.streams[id]
	delete(s.streams, id)
	s.mu.Unlock()
	if local == nil {
		return
	}
	_ = local.Close()
	if notifyPeer {
		s.writeJSON(map[string]any{"t": "close-stream", "streamId": id})
	}
}

func (s *session) closeAll() {
	s.stop()
	s.mu.Lock()
	for id, c := range s.streams {
		_ = c.Close()
		delete(s.streams, id)
	}
	s.mu.Unlock()
}

// ensureCredential returns a saved credential, or exchanges the enrollment token
// for one and persists it (0600) under the state directory.
func ensureCredential(cfg config) (string, error) {
	path := filepath.Join(cfg.StateDir, "credential")
	if b, err := os.ReadFile(path); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s, nil
		}
	}
	if cfg.Enroll == "" {
		return "", fmt.Errorf("no saved credential at %s and ENROLL is not set", path)
	}
	cred, err := enroll(cfg)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return "", fmt.Errorf("create state dir: %w", err)
	}
	if err := os.WriteFile(path, []byte(cred), 0o600); err != nil {
		return "", fmt.Errorf("save credential: %w", err)
	}
	log.Printf("enrolled; credential saved to %s", path)
	return cred, nil
}

func enroll(cfg config) (string, error) {
	body, _ := json.Marshal(map[string]string{"token": cfg.Enroll})
	req, err := http.NewRequest("POST", strings.TrimRight(cfg.URL, "/")+"/api/fabric/enroll", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("enroll rejected: %s", resp.Status)
	}
	var out struct {
		Credential string `json:"credential"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Credential == "" {
		return "", fmt.Errorf("enroll response missing credential")
	}
	return out.Credential, nil
}

type target struct {
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

// detectTargets probes the usual local remote-access ports and declares whichever
// are listening, falling back to the OS default so the agent always offers one.
func detectTargets() []target {
	var out []target
	add := func(kind string, port int) {
		out = append(out, target{Kind: kind, Host: "127.0.0.1", Port: port})
	}
	if portOpen(22) {
		add("ssh", 22)
	}
	if portOpen(3389) {
		add("rdp", 3389)
	}
	if portOpen(5900) {
		add("vnc", 5900) // VNC / macOS Screen Sharing
	}
	if len(out) == 0 {
		if runtime.GOOS == "windows" {
			add("rdp", 3389)
		} else {
			add("ssh", 22)
		}
	}
	return out
}

// allowSet is the tunnel allow-list: the agent will only dial these host:port
// pairs. It is the declared targets plus the standard loopback SSH/RDP ports, so
// the broker can never pivot the agent into arbitrary host:ports on the box.
func allowSet(ts []target) map[string]bool {
	m := map[string]bool{
		"127.0.0.1:22":   true,
		"127.0.0.1:3389": true,
		"127.0.0.1:5900": true,
	}
	for _, t := range ts {
		m[fmt.Sprintf("%s:%d", t.Host, t.Port)] = true
	}
	return m
}

func portOpen(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

func loadConfig() config {
	configDir := getenv("CEREBRO_CONFIG_DIR", defaultConfigDir())
	fileVals := readEnvFile(filepath.Join(configDir, "config.env"))
	get := func(k string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return fileVals[k]
	}
	stateDir := get("CEREBRO_STATE_DIR")
	if stateDir == "" {
		stateDir = os.Getenv("STATE_DIRECTORY") // set by systemd StateDirectory=
	}
	if stateDir == "" {
		stateDir = configDir
	}
	return config{
		URL:      strings.TrimRight(get("CEREBRO_URL"), "/"),
		Enroll:   get("ENROLL"),
		StateDir: stateDir,
	}
}

func defaultConfigDir() string {
	if runtime.GOOS == "windows" {
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "CerebroAgent")
	}
	return "/etc/cerebro-agent"
}

func readEnvFile(path string) map[string]string {
	m := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return m
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		i := strings.Index(line, "=")
		if i <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:i])
		val := strings.Trim(strings.TrimSpace(line[i+1:]), `"'`)
		m[key] = val
	}
	return m
}

func toWS(httpURL string) string {
	switch {
	case strings.HasPrefix(httpURL, "https://"):
		return "wss://" + strings.TrimPrefix(httpURL, "https://")
	case strings.HasPrefix(httpURL, "http://"):
		return "ws://" + strings.TrimPrefix(httpURL, "http://")
	default:
		return httpURL
	}
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return ""
	}
	return h
}

// osVersion is best-effort: PRETTY_NAME from /etc/os-release on Linux, empty
// elsewhere (the server treats it as optional).
func osVersion() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if pn := readEnvFile("/etc/os-release")["PRETTY_NAME"]; pn != "" {
		return pn
	}
	return ""
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// --- Self-update ------------------------------------------------------------
//
// The broker advertises its latest agent version in hello-ack; an older agent
// downloads the matching binary and swaps itself out (doSelfUpdate is
// OS-specific, since replacing a running executable differs on Windows). One
// attempt at a time; disabled by CEREBRO_NO_AUTO_UPDATE.

var updating atomic.Bool

func autoUpdateDisabled() bool {
	v := os.Getenv("CEREBRO_NO_AUTO_UPDATE")
	return v == "1" || strings.EqualFold(v, "true")
}

func trySelfUpdate(cfg config) {
	if !updating.CompareAndSwap(false, true) {
		return
	}
	if err := doSelfUpdate(cfg); err != nil {
		log.Printf("self-update failed: %v", err)
		updating.Store(false) // allow a retry on a later hello-ack
	}
}

// downloadAgentBinary fetches the current agent binary for this OS/arch to dest.
func downloadAgentBinary(cfg config, dest string) error {
	url := strings.TrimRight(cfg.URL, "/") + "/api/fabric/agent/binary?os=" + runtime.GOOS + "&arch=" + runtime.GOARCH
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	if n < 1024 {
		return fmt.Errorf("downloaded binary is implausibly small (%d bytes)", n)
	}
	return nil
}

// versionLess reports whether dotted version a is older than b (e.g. 0.2.0 < 0.3.0).
func versionLess(a, b string) bool {
	pa, pb := parseVer(a), parseVer(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func parseVer(s string) [3]int {
	var out [3]int
	for i, part := range strings.SplitN(s, ".", 3) {
		if i >= 3 {
			break
		}
		n, _ := strconv.Atoi(strings.TrimSpace(part))
		out[i] = n
	}
	return out
}

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
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const agentVersion = "0.2.0"

// Keep in step with FABRIC_HEARTBEAT_MS in packages/shared/src/fabric.ts.
const heartbeatInterval = 15 * time.Second

type config struct {
	URL      string
	Enroll   string
	StateDir string
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	cfg := loadConfig()
	if cfg.URL == "" {
		log.Fatal("CEREBRO_URL is not set (env or config.env).")
	}

	cred, err := ensureCredential(cfg)
	if err != nil {
		log.Fatalf("enrollment failed: %v", err)
	}
	log.Printf("cerebro-agent v%s starting; endpoint=%s", agentVersion, cfg.URL)

	backoff := time.Second
	for {
		if err := run(cfg, cred); err != nil {
			log.Printf("connection ended: %v", err)
		}
		jitter := time.Duration(time.Now().UnixNano()%int64(time.Second)) / 2
		time.Sleep(backoff + jitter)
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
func run(cfg config, cred string) error {
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
	sess := newSession(conn, allowSet(targets))
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
	for {
		select {
		case err := <-readErr:
			sess.stop()
			<-writerDone
			return err
		case <-ticker.C:
			sess.writeJSON(map[string]string{"t": "heartbeat"})
		}
	}
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
	out      chan outMsg
	quit     chan struct{}
	quitOnce sync.Once
	mu       sync.Mutex
	streams  map[uint32]net.Conn
}

func newSession(conn *websocket.Conn, allow map[string]bool) *session {
	return &session{
		conn:    conn,
		allow:   allow,
		out:     make(chan outMsg, 128),
		quit:    make(chan struct{}),
		streams: map[uint32]net.Conn{},
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
	T        string `json:"t"`
	StreamID uint32 `json:"streamId"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
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
	case "hello-ack", "ping":
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

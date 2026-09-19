// cerebro — native CLI for Cerebro Fabric.
//
// `cerebro access <machine> [ssh|rdp]` opens a local TCP listener and tunnels
// it through Cerebro to the machine's agent, so you can use your own ssh / scp /
// mstsc / RDP client over the same outbound tunnel the browser uses.
//
// `cerebro proxy <machine>` is the stdin/stdout variant for SSH's ProxyCommand,
// and `cerebro ssh <machine>` is a convenience wrapper that launches your own ssh
// through the tunnel — both let you "bring your own client" with your own keys.
//
// Config (first non-empty wins): --url/--token flags, CEREBRO_URL/CEREBRO_TOKEN
// env, or ~/.cerebro/config.json {"url":"…","token":"cbro_…"}. The token is a
// Cerebro API token with the fabric:read + fabric:connect scopes.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type config struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

type targetInfo struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

type agentInfo struct {
	ID      string       `json:"id"`
	Name    string       `json:"name"`
	OS      string       `json:"os"`
	Status  string       `json:"status"`
	Targets []targetInfo `json:"targets"`
}

func main() {
	log.SetFlags(0)
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		return
	}
	switch args[0] {
	case "ls":
		cmdLs(args[1:])
	case "access":
		cmdAccess(args[1:])
	case "proxy":
		cmdProxy(args[1:])
	case "ssh":
		cmdSSH(args[1:])
	case "ca":
		cmdCa(args[1:])
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", args[0])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Print(`cerebro — Cerebro Fabric CLI

Usage:
  cerebro ls
  cerebro access <machine> [ssh|rdp] [--listen 127.0.0.1:PORT]
  cerebro proxy  <machine> [ssh|rdp]            (SSH ProxyCommand — stdio)
  cerebro ssh    [--ca] [user@]<machine> [ssh args…]  (launch your own ssh client)
  cerebro ca                                    (print the CA public key + host setup)

Options:
  --url    <url>     Cerebro base URL          (or CEREBRO_URL)
  --token  <token>   Cerebro API token         (or CEREBRO_TOKEN)
  --listen <addr>    Local listen address      (default 127.0.0.1:0)

Bring your own SSH client:
  # one-off, using the wrapper (your keys, your config):
  cerebro ssh ember@my-mac

  # or wire it into ~/.ssh/config once, then use plain ssh/scp/sftp:
  #   Host my-mac.fabric
  #       ProxyCommand cerebro proxy my-mac
  #       User ember
  ssh my-mac.fabric

The token needs the fabric:read and fabric:connect scopes (Settings → API Tokens).
Config file: ~/.cerebro/config.json  {"url":"https://cerebro…","token":"cbro_…"}
`)
}

// --- commands ---------------------------------------------------------------

func cmdLs(args []string) {
	var urlFlag, tokenFlag string
	parseFlags(args, map[string]*string{"url": &urlFlag, "token": &tokenFlag})
	cfg := mustConfig(urlFlag, tokenFlag)
	agents := fetchAgents(cfg)
	if len(agents) == 0 {
		fmt.Println("No machines.")
		return
	}
	for _, a := range agents {
		var t []string
		for _, tg := range a.Targets {
			t = append(t, fmt.Sprintf("%s:%d", tg.Kind, tg.Port))
		}
		fmt.Printf("%-24s %-9s %s\n", a.Name, a.Status, strings.Join(t, "  "))
	}
}

func cmdAccess(args []string) {
	var urlFlag, tokenFlag, listen string
	pos := parseFlags(args, map[string]*string{"url": &urlFlag, "token": &tokenFlag, "listen": &listen})
	if len(pos) < 1 {
		fmt.Fprintln(os.Stderr, "usage: cerebro access <machine> [ssh|rdp] [--listen 127.0.0.1:PORT]")
		os.Exit(2)
	}
	machine := pos[0]
	kind := ""
	if len(pos) >= 2 {
		kind = strings.ToLower(pos[1])
	}
	cfg := mustConfig(urlFlag, tokenFlag)
	agentName, target := resolveTarget(cfg, machine, kind)

	if listen == "" {
		listen = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		log.Fatalf("listen %s: %v", listen, err)
	}
	addr := ln.Addr().String()
	fmt.Printf("Forwarding %s -> %s (%s :%d) through Cerebro. Ctrl+C to stop.\n", addr, agentName, target.Kind, target.Port)
	fmt.Println("  " + hint(target.Kind, addr))

	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go bridge(conn, cfg, target.ID)
	}
}

// cmdProxy bridges stdin/stdout to a target — the shape SSH's ProxyCommand wants,
// so `ssh -o ProxyCommand="cerebro proxy <machine>" …` (or a ~/.ssh/config Host)
// tunnels your own ssh/scp/sftp with your own keys. All diagnostics go to stderr;
// stdout carries only the SSH byte stream.
func cmdProxy(args []string) {
	var urlFlag, tokenFlag string
	pos := parseFlags(args, map[string]*string{"url": &urlFlag, "token": &tokenFlag})
	if len(pos) < 1 {
		fmt.Fprintln(os.Stderr, "usage: cerebro proxy <machine> [ssh|rdp]")
		os.Exit(2)
	}
	kind := "ssh"
	if len(pos) >= 2 {
		kind = strings.ToLower(pos[1])
	}
	cfg := mustConfig(urlFlag, tokenFlag)
	_, target := resolveTarget(cfg, pos[0], kind)
	proxyStdio(cfg, target.ID)
}

// cmdSSH sets up a temporary local forward and launches the system ssh client at
// it, passing through any extra ssh args. A stable HostKeyAlias keeps known_hosts
// from churning as the ephemeral local port changes between runs.
func cmdSSH(args []string) {
	// --ca is a boolean; pull it out before flag/positional parsing.
	caMode := false
	var rest []string
	for _, a := range args {
		if a == "--ca" {
			caMode = true
			continue
		}
		rest = append(rest, a)
	}
	var urlFlag, tokenFlag string
	pos := parseFlags(rest, map[string]*string{"url": &urlFlag, "token": &tokenFlag})
	if len(pos) < 1 {
		fmt.Fprintln(os.Stderr, "usage: cerebro ssh [--ca] [user@]<machine> [ssh args…]")
		os.Exit(2)
	}
	spec, extra := pos[0], pos[1:]
	user, machine := "", spec
	if at := strings.LastIndexByte(spec, '@'); at >= 0 {
		user, machine = spec[:at], spec[at+1:]
	}

	sshBin, err := exec.LookPath("ssh")
	if err != nil {
		log.Fatal("no 'ssh' client found on PATH — install OpenSSH, or use `cerebro access` and connect manually")
	}
	cfg := mustConfig(urlFlag, tokenFlag)
	name, target := resolveTarget(cfg, machine, "ssh")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go bridge(conn, cfg, target.ID)
		}
	}()

	dest := "127.0.0.1"
	if user != "" {
		dest = user + "@127.0.0.1"
	}
	sshArgs := []string{"-p", port, "-o", "HostKeyAlias=cerebro." + slug(name)}
	if caMode {
		// Mint an ephemeral key + short-lived CA cert and use only that identity.
		if user == "" {
			log.Fatal("--ca needs a login user: cerebro ssh --ca <user>@<machine>")
		}
		certDir := issueCert(cfg, user, name)
		defer os.RemoveAll(certDir)
		sshArgs = append(sshArgs, "-i", filepath.Join(certDir, "id"), "-o", "IdentitiesOnly=yes")
	}
	sshArgs = append(sshArgs, extra...)
	sshArgs = append(sshArgs, dest)

	fmt.Fprintf(os.Stderr, "Connecting to %s over Cerebro…\n", name)
	cmd := exec.Command(sshBin, sshArgs...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		log.Fatalf("ssh: %v", err)
	}
}

// cmdCa prints the SSH CA public key and the host-trust setup snippets.
func cmdCa(args []string) {
	var urlFlag, tokenFlag string
	parseFlags(args, map[string]*string{"url": &urlFlag, "token": &tokenFlag})
	cfg := mustConfig(urlFlag, tokenFlag)
	b := apiGet(cfg, "/api/fabric/ca")
	var s struct {
		Enabled          bool   `json:"enabled"`
		PublicKey        string `json:"publicKey"`
		TTLMinutes       int    `json:"ttlMinutes"`
		HostSetupLinux   string `json:"hostSetupLinux"`
		HostSetupWindows string `json:"hostSetupWindows"`
	}
	_ = json.Unmarshal(b, &s)
	if !s.Enabled {
		fmt.Println("The SSH CA is not enabled. An admin can turn it on in Fabric → SSH CA.")
		return
	}
	fmt.Println("# Cerebro SSH CA public key:")
	fmt.Println(s.PublicKey)
	fmt.Printf("\n# Certificates are valid for %d minutes.\n", s.TTLMinutes)
	fmt.Println("\n# Trust this CA on a Linux/macOS host (run on the box):")
	fmt.Println(s.HostSetupLinux)
	fmt.Println("\n# Trust this CA on a Windows host (elevated PowerShell):")
	fmt.Println(s.HostSetupWindows)
	fmt.Println("\n# Then connect with a signed cert (no key setup):")
	fmt.Println("  cerebro ssh --ca <user>@<machine>")
}

// issueCert generates an ephemeral keypair, gets it signed by the Cerebro CA for
// `principal`, and returns a temp dir holding `id` (+ `id-cert.pub`) for ssh -i.
func issueCert(cfg config, principal, machine string) string {
	kg, err := exec.LookPath("ssh-keygen")
	if err != nil {
		log.Fatal("ssh-keygen not found — it is required for --ca")
	}
	dir, err := os.MkdirTemp("", "cbrocert-")
	if err != nil {
		log.Fatalf("temp dir: %v", err)
	}
	keyPath := filepath.Join(dir, "id")
	if out, err := exec.Command(kg, "-t", "ed25519", "-f", keyPath, "-N", "", "-q").CombinedOutput(); err != nil {
		os.RemoveAll(dir)
		log.Fatalf("generate key: %v %s", err, out)
	}
	pub, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		os.RemoveAll(dir)
		log.Fatalf("read key: %v", err)
	}
	body := map[string]string{"publicKey": strings.TrimSpace(string(pub)), "principal": principal, "machine": machine}
	respBytes := apiPost(cfg, "/api/fabric/ca/sign", body)
	var r struct {
		Certificate string `json:"certificate"`
		TTLMinutes  int    `json:"ttlMinutes"`
	}
	if err := json.Unmarshal(respBytes, &r); err != nil || r.Certificate == "" {
		os.RemoveAll(dir)
		log.Fatal("the CA did not return a certificate — is the SSH CA enabled?")
	}
	if err := os.WriteFile(keyPath+"-cert.pub", []byte(r.Certificate+"\n"), 0o644); err != nil {
		os.RemoveAll(dir)
		log.Fatalf("write cert: %v", err)
	}
	fmt.Fprintf(os.Stderr, "Issued a %d-minute certificate for %q.\n", r.TTLMinutes, principal)
	return dir
}

// resolveTarget finds a machine by name and picks a target of `kind` (or the
// default order). Fatal if the machine or a matching target is missing; warns to
// stderr if the agent is offline.
func resolveTarget(cfg config, machine, kind string) (string, *targetInfo) {
	for _, a := range fetchAgents(cfg) {
		if strings.EqualFold(a.Name, machine) {
			if a.Status != "online" {
				fmt.Fprintf(os.Stderr, "warning: %s is %s\n", a.Name, a.Status)
			}
			t := pickTarget(a.Targets, kind)
			if t == nil {
				log.Fatalf("no matching target on %q", machine)
			}
			return a.Name, t
		}
	}
	log.Fatalf("machine %q not found (try: cerebro ls)", machine)
	return "", nil
}

// slug reduces a machine name to a stable token for HostKeyAlias.
func slug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "host"
	}
	return out
}

func pickTarget(targets []targetInfo, kind string) *targetInfo {
	if kind != "" {
		for i := range targets {
			if targets[i].Kind == kind {
				return &targets[i]
			}
		}
		return nil
	}
	for _, want := range []string{"ssh", "rdp"} {
		for i := range targets {
			if targets[i].Kind == want {
				return &targets[i]
			}
		}
	}
	if len(targets) > 0 {
		return &targets[0]
	}
	return nil
}

func hint(kind, addr string) string {
	host, port, _ := net.SplitHostPort(addr)
	switch kind {
	case "ssh":
		return fmt.Sprintf("Connect: ssh -p %s <user>@%s", port, host)
	case "rdp":
		if runtime.GOOS == "windows" {
			return fmt.Sprintf("Connect: mstsc /v:%s", addr)
		}
		return fmt.Sprintf("Connect your RDP client to %s", addr)
	default:
		return "Connect your client to " + addr
	}
}

// --- tunnel bridge ----------------------------------------------------------

// proxyStdio pipes stdin/stdout to a target over the access tunnel (ProxyCommand
// mode). Exits as soon as either direction closes, so ssh sees a clean EOF.
func proxyStdio(cfg config, targetID string) {
	wsURL := toWS(cfg.URL) + "/api/fabric/access/ws?target=" + url.QueryEscape(targetID)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.Token)
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 15 * time.Second
	ws, resp, err := d.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			log.Fatalf("tunnel rejected: %s", resp.Status)
		}
		log.Fatalf("tunnel error: %v", err)
	}
	defer ws.Close()

	ended := make(chan struct{}, 2)
	go func() { // ws -> stdout
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				break
			}
			if _, werr := os.Stdout.Write(msg); werr != nil {
				break
			}
		}
		ended <- struct{}{}
	}()
	go func() { // stdin -> ws (sole ws writer)
		buf := make([]byte, 32*1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					break
				}
			}
			if err != nil {
				break
			}
		}
		ended <- struct{}{}
	}()
	<-ended // first side to close ends the session
}

func bridge(local net.Conn, cfg config, targetID string) {
	defer local.Close()
	wsURL := toWS(cfg.URL) + "/api/fabric/access/ws?target=" + url.QueryEscape(targetID)
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.Token)
	d := *websocket.DefaultDialer
	d.HandshakeTimeout = 15 * time.Second
	ws, resp, err := d.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			log.Printf("tunnel rejected: %s", resp.Status)
		} else {
			log.Printf("tunnel error: %v", err)
		}
		return
	}
	defer ws.Close()

	done := make(chan struct{})
	go func() { // ws -> local
		defer close(done)
		for {
			_, msg, err := ws.ReadMessage()
			if err != nil {
				return
			}
			if _, err := local.Write(msg); err != nil {
				return
			}
		}
	}()

	buf := make([]byte, 32*1024)
	for { // local -> ws (sole ws writer)
		n, err := local.Read(buf)
		if n > 0 {
			if werr := ws.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
				break
			}
		}
		if err != nil {
			break
		}
	}
	_ = ws.Close()
	_ = local.Close()
	<-done
}

// --- config + http ----------------------------------------------------------

// apiGet does an authenticated GET and returns the body, fataling on any error.
func apiGet(cfg config, path string) []byte {
	req, _ := http.NewRequest("GET", cfg.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	return doAPI(req)
}

// apiPost does an authenticated JSON POST and returns the body, fataling on error.
func apiPost(cfg config, path string, body any) []byte {
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", cfg.URL+path, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	return doAPI(req)
}

func doAPI(req *http.Request) []byte {
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		log.Fatalf("cannot reach Cerebro: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		log.Fatalf("unauthorized — the token needs the fabric:read + fabric:connect scopes")
	}
	if resp.StatusCode/100 != 2 {
		msg := strings.TrimSpace(string(body))
		if m := extractMessage(body); m != "" {
			msg = m
		}
		log.Fatalf("%s: %s", resp.Status, msg)
	}
	return body
}

// extractMessage pulls a JSON {"message": …} error out of a body if present.
func extractMessage(body []byte) string {
	var e struct {
		Message any `json:"message"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	switch m := e.Message.(type) {
	case string:
		return m
	case []any:
		var parts []string
		for _, p := range m {
			parts = append(parts, fmt.Sprint(p))
		}
		return strings.Join(parts, ", ")
	}
	return ""
}

func fetchAgents(cfg config) []agentInfo {
	req, _ := http.NewRequest("GET", cfg.URL+"/api/fabric/agents", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Fatalf("cannot reach Cerebro: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		log.Fatalf("unauthorized — the token needs the fabric:read + fabric:connect scopes")
	}
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Fatalf("list agents: %s %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var agents []agentInfo
	if err := json.NewDecoder(resp.Body).Decode(&agents); err != nil {
		log.Fatalf("decode agents: %v", err)
	}
	return agents
}

func mustConfig(urlFlag, tokenFlag string) config {
	file := readConfigFile()
	cfg := config{
		URL:   strings.TrimRight(firstNonEmpty(urlFlag, os.Getenv("CEREBRO_URL"), file.URL), "/"),
		Token: firstNonEmpty(tokenFlag, os.Getenv("CEREBRO_TOKEN"), file.Token),
	}
	if cfg.URL == "" || cfg.Token == "" {
		log.Fatal("set --url/--token, CEREBRO_URL/CEREBRO_TOKEN, or ~/.cerebro/config.json")
	}
	return cfg
}

func readConfigFile() config {
	home, err := os.UserHomeDir()
	if err != nil {
		return config{}
	}
	b, err := os.ReadFile(filepath.Join(home, ".cerebro", "config.json"))
	if err != nil {
		return config{}
	}
	var c config
	_ = json.Unmarshal(b, &c)
	return c
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
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

// parseFlags pulls known --key value / --key=value pairs out of args and returns
// the remaining positional arguments.
func parseFlags(args []string, keys map[string]*string) []string {
	var pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "--") {
			name := a[2:]
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				if p, ok := keys[name[:eq]]; ok {
					*p = name[eq+1:]
					continue
				}
			} else if p, ok := keys[name]; ok {
				if i+1 < len(args) {
					*p = args[i+1]
					i++
				}
				continue
			}
			// unknown flag — ignore
		} else {
			pos = append(pos, a)
		}
	}
	return pos
}

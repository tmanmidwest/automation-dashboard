// cerebro — native CLI for Cerebro Fabric.
//
// `cerebro access <machine> [ssh|rdp]` opens a local TCP listener and tunnels
// it through Cerebro to the machine's agent, so you can use your own ssh / scp /
// mstsc / RDP client over the same outbound tunnel the browser uses.
//
// Config (first non-empty wins): --url/--token flags, CEREBRO_URL/CEREBRO_TOKEN
// env, or ~/.cerebro/config.json {"url":"…","token":"cbro_…"}. The token is a
// Cerebro API token with the fabric:read + fabric:connect scopes.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
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

Options:
  --url    <url>     Cerebro base URL          (or CEREBRO_URL)
  --token  <token>   Cerebro API token         (or CEREBRO_TOKEN)
  --listen <addr>    Local listen address      (default 127.0.0.1:0)

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

	var agentName string
	var target *targetInfo
	for _, a := range fetchAgents(cfg) {
		if strings.EqualFold(a.Name, machine) {
			agentName = a.Name
			target = pickTarget(a.Targets, kind)
			if a.Status != "online" {
				fmt.Fprintf(os.Stderr, "warning: %s is %s\n", a.Name, a.Status)
			}
			break
		}
	}
	if agentName == "" {
		log.Fatalf("machine %q not found (try: cerebro ls)", machine)
	}
	if target == nil {
		log.Fatalf("no matching target on %q", machine)
	}

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

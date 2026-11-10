package main

// Resource health collector (Cerebro Health, docs/health-monitoring.md).
//
// Runs for the life of the process, independent of the WebSocket: it samples
// CPU every few seconds and, once per reporting interval, builds one sample
// (CPU avg/peak, memory, swap, every real filesystem, disk + network throughput,
// uptime). Samples queue in a small ring buffer that the connection loop drains
// onto the socket, so a box that loses its connection for a while still reports
// what happened once it reconnects (up to healthBufferMax samples).
//
// Everything here is read-only and best-effort: a metric the OS won't give us is
// simply left out (nil / absent), never reported as zero.

import (
	"log"
	"net"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

const (
	// Default reporting cadence; the broker overrides it in hello-ack / health-config.
	defaultHealthInterval = 30 * time.Second
	// CPU is sub-sampled at this rate inside an interval so short spikes show up as the peak.
	healthSubSample = 10 * time.Second
	// Samples kept while disconnected (~1 h at the default 30 s cadence).
	healthBufferMax = 120
	// Inventory (hardware/OS facts) is re-sent this often, and on every reconnect.
	inventoryEvery = 6 * time.Hour
)

type healthDisk struct {
	Mount      string   `json:"mount"`
	Device     string   `json:"device,omitempty"`
	FS         string   `json:"fs,omitempty"`
	TotalBytes uint64   `json:"totalBytes"`
	UsedBytes  uint64   `json:"usedBytes"`
	Pct        float64  `json:"pct"`
	InodesPct  *float64 `json:"inodesPct,omitempty"`
}

type healthSample struct {
	At           int64        `json:"at"`      // unix ms, end of the window
	SpanSec      int          `json:"spanSec"` // seconds this sample covers
	CPUPct       *float64     `json:"cpuPct,omitempty"`
	CPUMaxPct    *float64     `json:"cpuMaxPct,omitempty"`
	Load1        *float64     `json:"load1,omitempty"`
	Load5        *float64     `json:"load5,omitempty"`
	Load15       *float64     `json:"load15,omitempty"`
	MemTotal     uint64       `json:"memTotal,omitempty"`
	MemUsed      uint64       `json:"memUsed,omitempty"`
	MemPct       *float64     `json:"memPct,omitempty"`
	SwapTotal    uint64       `json:"swapTotal,omitempty"`
	SwapUsed     uint64       `json:"swapUsed,omitempty"`
	SwapPct      *float64     `json:"swapPct,omitempty"`
	Disks        []healthDisk `json:"disks,omitempty"`
	DiskReadBps  *float64     `json:"diskReadBps,omitempty"`
	DiskWriteBps *float64     `json:"diskWriteBps,omitempty"`
	NetRxBps     *float64     `json:"netRxBps,omitempty"`
	NetTxBps     *float64     `json:"netTxBps,omitempty"`
	UptimeSec    uint64       `json:"uptimeSec,omitempty"`
	Procs        int          `json:"procs,omitempty"`
}

type healthInventory struct {
	Hostname        string   `json:"hostname,omitempty"`
	OS              string   `json:"os"`
	Arch            string   `json:"arch"`
	Platform        string   `json:"platform,omitempty"`
	PlatformVersion string   `json:"platformVersion,omitempty"`
	PlatformFamily  string   `json:"platformFamily,omitempty"`
	KernelVersion   string   `json:"kernelVersion,omitempty"`
	CPUModel        string   `json:"cpuModel,omitempty"`
	CPUCores        int      `json:"cpuCores,omitempty"`
	CPUThreads      int      `json:"cpuThreads,omitempty"`
	MemTotal        uint64   `json:"memTotal,omitempty"`
	VirtSystem      string   `json:"virtSystem,omitempty"` // kvm, vmware, docker, lxc, …
	VirtRole        string   `json:"virtRole,omitempty"`   // guest | host
	HasBattery      bool     `json:"hasBattery"`
	BootTime        int64    `json:"bootTime,omitempty"` // unix seconds
	Macs            []string `json:"macs,omitempty"`
	IPs             []string `json:"ips,omitempty"`
}

type healthCollector struct {
	intervalMs atomic.Int64 // 0 = disabled by the broker
	wake       chan struct{}

	mu        sync.Mutex
	buf       []healthSample
	inventory *healthInventory
	invAt     time.Time

	// rate state (collector goroutine only)
	lastNetRx, lastNetTx, lastRead, lastWrite uint64
	lastRateAt                                time.Time
	haveNet, haveDisk                         bool
}

var health = newHealthCollector()

func newHealthCollector() *healthCollector {
	h := &healthCollector{wake: make(chan struct{}, 1)}
	h.intervalMs.Store(defaultHealthInterval.Milliseconds())
	return h
}

// setInterval adopts the broker's cadence (ms). 0 disables collection; values are
// clamped to 5 s … 10 min so a bad setting can't spin or starve the box.
func (h *healthCollector) setInterval(ms int64) {
	if ms != 0 {
		if ms < 5_000 {
			ms = 5_000
		}
		if ms > 600_000 {
			ms = 600_000
		}
	}
	if h.intervalMs.Swap(ms) != ms {
		log.Printf("health interval set to %dms by broker", ms)
		h.now() // restart the window on the new cadence
	}
}

// now asks the collector to report immediately (operator clicked Refresh).
func (h *healthCollector) now() {
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// requestInventory marks inventory to be sent with the next drain (on reconnect).
func (h *healthCollector) requestInventory() {
	h.mu.Lock()
	h.invAt = time.Time{}
	h.mu.Unlock()
}

// drain hands the queued samples (and inventory, when due) to the caller.
func (h *healthCollector) drain() ([]healthSample, *healthInventory) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.buf
	h.buf = nil
	var inv *healthInventory
	if h.inventory != nil && (h.invAt.IsZero() || time.Since(h.invAt) > inventoryEvery) {
		inv = h.inventory
		h.invAt = time.Now()
	}
	return out, inv
}

func (h *healthCollector) push(s healthSample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.buf = append(h.buf, s)
	if len(h.buf) > healthBufferMax {
		h.buf = h.buf[len(h.buf)-healthBufferMax:]
	}
}

// run is the collector loop; never returns. A panic in a collector is recovered
// and the loop restarted, so health can never take remote access down with it.
func (h *healthCollector) run() {
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("health collector panic (restarting): %v", r)
					time.Sleep(30 * time.Second)
				}
			}()
			h.loop()
		}()
	}
}

func (h *healthCollector) loop() {
	h.refreshInventory()
	_, _ = cpu.Percent(0, false) // prime the delta
	windowStart := time.Now()
	var cpuSum, cpuMax float64
	var cpuN int
	sub := time.NewTicker(healthSubSample)
	defer sub.Stop()
	invTick := time.NewTicker(inventoryEvery)
	defer invTick.Stop()

	takeCPU := func() {
		if v, err := cpu.Percent(0, false); err == nil && len(v) > 0 {
			cpuSum += v[0]
			cpuN++
			if v[0] > cpuMax {
				cpuMax = v[0]
			}
		}
	}

	report := func() {
		takeCPU()
		interval := time.Duration(h.intervalMs.Load()) * time.Millisecond
		if interval <= 0 {
			cpuSum, cpuMax, cpuN = 0, 0, 0
			windowStart = time.Now()
			return
		}
		s := h.collect(time.Since(windowStart))
		if cpuN > 0 {
			avg := round1(cpuSum / float64(cpuN))
			peak := round1(cpuMax)
			s.CPUPct, s.CPUMaxPct = &avg, &peak
		}
		h.push(s)
		cpuSum, cpuMax, cpuN = 0, 0, 0
		windowStart = time.Now()
	}

	for {
		interval := time.Duration(h.intervalMs.Load()) * time.Millisecond
		select {
		case <-sub.C:
			if interval <= 0 {
				continue
			}
			takeCPU()
			if time.Since(windowStart) >= interval-time.Second {
				report()
			}
		case <-h.wake:
			report()
		case <-invTick.C:
			h.refreshInventory()
		}
		// Sub-sample faster than the default when the interval is short.
		if interval > 0 && interval < healthSubSample {
			sub.Reset(interval)
		} else {
			sub.Reset(healthSubSample)
		}
	}
}

func (h *healthCollector) collect(span time.Duration) healthSample {
	now := time.Now()
	s := healthSample{At: now.UnixMilli(), SpanSec: int(span.Round(time.Second) / time.Second)}
	if s.SpanSec <= 0 {
		s.SpanSec = 1
	}

	if runtime.GOOS != "windows" {
		if l, err := load.Avg(); err == nil {
			a, b, c := round2(l.Load1), round2(l.Load5), round2(l.Load15)
			s.Load1, s.Load5, s.Load15 = &a, &b, &c
		}
	}
	if vm, err := mem.VirtualMemory(); err == nil && vm.Total > 0 {
		s.MemTotal = vm.Total
		// "Used" = total - available: what the OS can't hand out without reclaiming
		// (page cache counts as free), which is the number people mean by "memory full".
		used := vm.Total - vm.Available
		if vm.Available > vm.Total {
			used = vm.Used
		}
		s.MemUsed = used
		p := round1(float64(used) / float64(vm.Total) * 100)
		s.MemPct = &p
	}
	if sw, err := mem.SwapMemory(); err == nil && sw.Total > 0 {
		s.SwapTotal, s.SwapUsed = sw.Total, sw.Used
		p := round1(sw.UsedPercent)
		s.SwapPct = &p
	}
	s.Disks = collectDisks()
	if up, err := host.Uptime(); err == nil {
		s.UptimeSec = up
	}
	if pids, err := process.Pids(); err == nil {
		s.Procs = len(pids)
	}

	// Throughput: bytes since the previous report / elapsed.
	elapsed := now.Sub(h.lastRateAt).Seconds()
	rx, tx, okNet := netTotals()
	rd, wr, okDisk := diskIOTotals()
	if !h.lastRateAt.IsZero() && elapsed > 0 {
		if okNet && h.haveNet && rx >= h.lastNetRx && tx >= h.lastNetTx {
			a, b := round0(float64(rx-h.lastNetRx)/elapsed), round0(float64(tx-h.lastNetTx)/elapsed)
			s.NetRxBps, s.NetTxBps = &a, &b
		}
		if okDisk && h.haveDisk && rd >= h.lastRead && wr >= h.lastWrite {
			a, b := round0(float64(rd-h.lastRead)/elapsed), round0(float64(wr-h.lastWrite)/elapsed)
			s.DiskReadBps, s.DiskWriteBps = &a, &b
		}
	}
	h.lastNetRx, h.lastNetTx, h.haveNet = rx, tx, okNet
	h.lastRead, h.lastWrite, h.haveDisk = rd, wr, okDisk
	h.lastRateAt = now
	return s
}

func (h *healthCollector) refreshInventory() {
	inv := &healthInventory{OS: runtime.GOOS, Arch: runtime.GOARCH, HasBattery: hasBattery()}
	if hi, err := host.Info(); err == nil {
		inv.Hostname = hi.Hostname
		inv.Platform = hi.Platform
		inv.PlatformVersion = hi.PlatformVersion
		inv.PlatformFamily = hi.PlatformFamily
		inv.KernelVersion = hi.KernelVersion
		inv.VirtSystem = hi.VirtualizationSystem
		inv.VirtRole = hi.VirtualizationRole
		inv.BootTime = int64(hi.BootTime)
	} else {
		inv.Hostname, _ = os.Hostname()
	}
	if ci, err := cpu.Info(); err == nil && len(ci) > 0 {
		inv.CPUModel = strings.TrimSpace(ci[0].ModelName)
	}
	if n, err := cpu.Counts(false); err == nil {
		inv.CPUCores = n
	}
	if n, err := cpu.Counts(true); err == nil {
		inv.CPUThreads = n
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		inv.MemTotal = vm.Total
	}
	if ifs, err := net.Interfaces(); err == nil {
		for _, ifc := range ifs {
			if ifc.Flags&net.FlagLoopback != 0 || skipNetIface(ifc.Name) || len(ifc.HardwareAddr) == 0 {
				continue
			}
			inv.Macs = append(inv.Macs, strings.ToLower(ifc.HardwareAddr.String()))
			addrs, _ := ifc.Addrs()
			for _, a := range addrs {
				if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLinkLocalUnicast() {
					inv.IPs = append(inv.IPs, ipn.IP.String())
				}
			}
		}
	}
	h.mu.Lock()
	h.inventory = inv
	h.invAt = time.Time{} // send with the next drain
	h.mu.Unlock()
}

// ── Disks ───────────────────────────────────────────────────────────────────

// Pseudo / virtual filesystems that are never "your disk".
var skipFS = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "devfs": true, "overlay": true, "squashfs": true,
	"proc": true, "sysfs": true, "cgroup": true, "cgroup2": true, "autofs": true,
	"nsfs": true, "ramfs": true, "efivarfs": true, "debugfs": true, "tracefs": true,
	"securityfs": true, "pstore": true, "bpf": true, "configfs": true, "fusectl": true,
	"mqueue": true, "hugetlbfs": true, "binfmt_misc": true, "rpc_pipefs": true,
	"nullfs": true, "fdescfs": true, "aufs": true, "shm": true, "iso9660": true, "udf": true,
	"fuse.lxcfs": true, "fuse.gvfsd-fuse": true, "fuse.portal": true, "fuse.snapfuse": true,
}

var skipMountPrefixes = []string{
	"/proc", "/sys", "/dev", "/run", "/snap/", "/var/lib/docker/", "/var/lib/containers/",
	"/var/lib/kubelet/", "/var/snap/", "/boot/efi",
	// macOS sealed system + helper volumes share the Data volume's container.
	"/System/Volumes/VM", "/System/Volumes/Preboot", "/System/Volumes/Update",
	"/System/Volumes/xarts", "/System/Volumes/iSCPreboot", "/System/Volumes/Hardware",
	"/Library/Developer/CoreSimulator", "/private/var/vm",
}

func collectDisks() []healthDisk {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil
	}
	byDevice := map[string]healthDisk{}
	for _, p := range parts {
		fs := strings.ToLower(p.Fstype)
		if skipFS[fs] {
			continue
		}
		if skipMount(p.Mountpoint) {
			continue
		}
		// macOS: "/" is the sealed read-only system volume; the Data volume is
		// where usage lives. Keep "/" only if no Data volume is mounted.
		u, err := disk.Usage(p.Mountpoint)
		if err != nil || u.Total == 0 {
			continue
		}
		d := healthDisk{Mount: p.Mountpoint, Device: p.Device, FS: p.Fstype, TotalBytes: u.Total, UsedBytes: u.Used, Pct: round1(u.UsedPercent)}
		if u.InodesTotal > 0 && runtime.GOOS == "linux" {
			ip := round1(u.InodesUsedPercent)
			d.InodesPct = &ip
		}
		// The same device mounted in several places (bind mounts): keep the shortest path.
		key := p.Device
		if key == "" || key == "none" {
			key = p.Mountpoint
		}
		if prev, ok := byDevice[key]; ok && len(prev.Mount) <= len(d.Mount) {
			continue
		}
		byDevice[key] = d
	}
	out := make([]healthDisk, 0, len(byDevice))
	hasData := false
	for _, d := range byDevice {
		if d.Mount == "/System/Volumes/Data" {
			hasData = true
		}
	}
	for _, d := range byDevice {
		if runtime.GOOS == "darwin" && hasData && d.Mount == "/" {
			continue
		}
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Mount < out[j].Mount })
	if len(out) > 32 {
		out = out[:32]
	}
	return out
}

func skipMount(m string) bool {
	if runtime.GOOS == "windows" {
		return false
	}
	for _, p := range skipMountPrefixes {
		if m == strings.TrimSuffix(p, "/") || strings.HasPrefix(m, p) {
			return true
		}
	}
	return false
}

// Linux whole-disk names; partitions (sda1, nvme0n1p1, mmcblk0p1) and stacked
// devices (dm-*, md*, loop*) are skipped so throughput isn't double-counted.
var linuxWholeDisk = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$`)

func diskIOTotals() (read, write uint64, ok bool) {
	m, err := disk.IOCounters()
	if err != nil || len(m) == 0 {
		return 0, 0, false
	}
	for name, c := range m {
		if runtime.GOOS == "linux" && !linuxWholeDisk.MatchString(name) {
			continue
		}
		read += c.ReadBytes
		write += c.WriteBytes
	}
	return read, write, true
}

// ── Network ─────────────────────────────────────────────────────────────────

var skipIfacePrefixes = []string{"lo", "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "tun", "utun", "awdl", "llw", "anpi", "ap", "bridge", "gif", "stf", "isatap", "Loopback", "vEthernet"}

func skipNetIface(name string) bool {
	for _, p := range skipIfacePrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func netTotals() (rx, tx uint64, ok bool) {
	cs, err := gnet.IOCounters(true)
	if err != nil {
		return 0, 0, false
	}
	for _, c := range cs {
		if skipNetIface(c.Name) {
			continue
		}
		rx += c.BytesRecv
		tx += c.BytesSent
	}
	return rx, tx, true
}

// ── helpers ─────────────────────────────────────────────────────────────────

func round0(v float64) float64 { return float64(int64(v + 0.5)) }
func round1(v float64) float64 { return float64(int64(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int64(v*100+0.5)) / 100 }

package main

import (
	"encoding/json"
	"testing"
	"time"
)

// Smoke test: one collection on the build machine produces sane numbers.
func TestHealthCollectSmoke(t *testing.T) {
	h := newHealthCollector()
	h.refreshInventory()
	_ = h.collect(time.Second)
	time.Sleep(1100 * time.Millisecond)
	s := h.collect(time.Second)
	if s.MemPct == nil || *s.MemPct <= 0 || *s.MemPct > 100 {
		t.Fatalf("memPct out of range: %v", s.MemPct)
	}
	if s.UptimeSec == 0 {
		t.Fatalf("uptime missing")
	}
	for _, d := range s.Disks {
		if d.Pct < 0 || d.Pct > 100 || d.TotalBytes == 0 {
			t.Fatalf("bad disk %+v", d)
		}
	}
	_, inv := h.drain()
	if inv == nil || inv.OS == "" {
		t.Fatalf("inventory not queued")
	}
	b, _ := json.MarshalIndent(map[string]any{"sample": s, "inventory": inv}, "", "  ")
	t.Log(string(b))
}

func TestHealthBufferCap(t *testing.T) {
	h := newHealthCollector()
	for i := 0; i < healthBufferMax+10; i++ {
		h.push(healthSample{At: int64(i)})
	}
	s, _ := h.drain()
	if len(s) != healthBufferMax || s[0].At != 10 {
		t.Fatalf("expected newest %d samples, got %d starting at %d", healthBufferMax, len(s), s[0].At)
	}
}

func TestSetIntervalClamp(t *testing.T) {
	h := newHealthCollector()
	h.setInterval(100)
	if h.intervalMs.Load() != 5000 {
		t.Fatal("not clamped low")
	}
	h.setInterval(0)
	if h.intervalMs.Load() != 0 {
		t.Fatal("0 should disable")
	}
}

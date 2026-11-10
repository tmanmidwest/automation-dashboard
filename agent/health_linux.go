//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
)

// hasBattery reports a system battery (laptop), ignoring peripheral batteries
// (wireless mice/keyboards report scope "Device").
func hasBattery() bool {
	dirs, _ := filepath.Glob("/sys/class/power_supply/*")
	for _, d := range dirs {
		t, _ := os.ReadFile(filepath.Join(d, "type"))
		if strings.TrimSpace(string(t)) != "Battery" {
			continue
		}
		if s, err := os.ReadFile(filepath.Join(d, "scope")); err == nil && strings.TrimSpace(string(s)) == "Device" {
			continue
		}
		return true
	}
	return false
}

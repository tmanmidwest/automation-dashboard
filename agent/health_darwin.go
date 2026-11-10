//go:build darwin

package main

import (
	"os/exec"
	"strings"
)

// hasBattery reports an internal battery (MacBook) via pmset.
func hasBattery() bool {
	out, err := exec.Command("pmset", "-g", "batt").Output()
	return err == nil && strings.Contains(string(out), "InternalBattery")
}

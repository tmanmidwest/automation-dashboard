//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// SYSTEM_POWER_STATUS (winbase.h).
type systemPowerStatus struct {
	ACLineStatus        byte
	BatteryFlag         byte
	BatteryLifePercent  byte
	SystemStatusFlag    byte
	BatteryLifeTime     uint32
	BatteryFullLifeTime uint32
}

var procGetSystemPowerStatus = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetSystemPowerStatus")

// hasBattery reports a system battery (laptop / tablet). BatteryFlag 128 = no
// system battery; 255 = unknown status (treated as none).
func hasBattery() bool {
	var s systemPowerStatus
	r, _, _ := procGetSystemPowerStatus.Call(uintptr(unsafe.Pointer(&s)))
	if r == 0 {
		return false
	}
	return s.BatteryFlag != 128 && s.BatteryFlag != 255
}

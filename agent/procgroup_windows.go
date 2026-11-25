//go:build windows

package main

import "os/exec"

// stopTreeOnCancel: Windows keeps the default (the context kills the process).
func stopTreeOnCancel(cmd *exec.Cmd) {}

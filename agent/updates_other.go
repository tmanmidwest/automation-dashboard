//go:build !linux && !darwin && !windows

package main

import (
	"context"
	"errors"
)

type unsupportedUpdater struct{}

func newOSUpdater() osUpdater { return unsupportedUpdater{} }

func (unsupportedUpdater) check(context.Context) updatesReport {
	return updatesReport{Error: "OS updates aren't supported on this system."}
}

func (unsupportedUpdater) install(context.Context, string, func(string)) (int, error) {
	return 0, errors.New("OS updates aren't supported on this system")
}

func (unsupportedUpdater) reboot() error { return errors.New("not supported") }

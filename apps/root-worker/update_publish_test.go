package main

// Tests never reach a NATS server: results are announced to nobody unless a test
// records them (recordPublishes).
func init() { publishUpdateResult = func(lastResult) {} }

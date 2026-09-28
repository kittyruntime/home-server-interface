package main

import (
	"log"
	"time"

	nats "github.com/nats-io/nats.go"
)

// handleHostReboot acknowledges the authenticated backend request before
// rebooting so the browser can enter its reconnect flow. Only the root worker
// has OS privileges; the web-facing backend cannot execute systemctl itself.
func handleHostReboot(nc *nats.Conn, msg *nats.Msg) {
	replyOk(nc, msg.Reply, map[string]bool{"scheduled": true})
	_ = nc.Flush()

	go func() {
		time.Sleep(750 * time.Millisecond)
		if out, err := command("systemctl", "--no-block", "reboot").CombinedOutput(); err != nil {
			log.Printf("host reboot failed: %v: %s", err, string(out))
		}
	}()
}

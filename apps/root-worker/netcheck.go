package main

import (
	"encoding/json"
	"fmt"
	"net"

	"github.com/nats-io/nats.go"
)

type portCheckReq struct {
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

// handleCheckPort handles root.sys.port.check (request-reply): it tries to bind the
// given host port and immediately releases it. A bind failure means something is
// already listening on it (a Docker userland-proxy, or a bare-metal process). This
// is the "non-Docker host process" source for the install-time port-conflict warning
// (the backend covers managed apps and Docker ports separately). The bind-then-close
// has a tiny race, which is acceptable for a soft, non-blocking warning.
func handleCheckPort(nc *nats.Conn, msg *nats.Msg) {
	var req portCheckReq
	if err := json.Unmarshal(msg.Data, &req); err != nil {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: err.Error()})
		return
	}
	if req.Port < 1 || req.Port > 65535 {
		replyErr(nc, msg.Reply, &fsError{Code: "ERR", Message: "port out of range"})
		return
	}
	addr := fmt.Sprintf(":%d", req.Port)

	inUse := false
	if req.Protocol == "udp" {
		if pc, err := net.ListenPacket("udp", addr); err != nil {
			inUse = true
		} else {
			_ = pc.Close()
		}
	} else {
		if ln, err := net.Listen("tcp", addr); err != nil {
			inUse = true
		} else {
			_ = ln.Close()
		}
	}
	replyOk(nc, msg.Reply, map[string]bool{"inUse": inUse})
}

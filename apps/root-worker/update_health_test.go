package main

import (
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWaitHealthyNamesFailingCheck(t *testing.T) {
	fakeHealth(t, nil, func() error { return errors.New("no responders") })
	err := waitHealthy(healthTarget{Version: "v2.1.0", Timeout: 50 * time.Millisecond, Interval: 10 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "worker") || strings.Contains(err.Error(), "server") {
		t.Fatalf("want an error naming the worker only, got %v", err)
	}

	fakeHealth(t, func() error { return errors.New("HTTP 503") }, nil)
	err = waitHealthy(healthTarget{Version: "v2.1.0", Timeout: 50 * time.Millisecond, Interval: 10 * time.Millisecond})
	if err == nil || !strings.Contains(err.Error(), "server") || strings.Contains(err.Error(), "worker") {
		t.Fatalf("want an error naming the server only, got %v", err)
	}

	fakeHealth(t, nil, nil)
	if err := waitHealthy(healthTarget{Version: "v2.1.0", Timeout: 50 * time.Millisecond, Interval: 10 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
}

func TestWaitHealthyRecoversWithinTimeout(t *testing.T) {
	n := 0
	fakeHealth(t, func() error {
		if n++; n < 3 {
			return errors.New("connection refused")
		}
		return nil
	}, nil)
	if err := waitHealthy(healthTarget{Version: "v2.1.0", Timeout: time.Second, Interval: 5 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
}

// A version before the health contract existed has no root.health: its worker unit is checked instead.
func TestWaitHealthyLegacyChecksWorkerUnit(t *testing.T) {
	calls := fakeSystemctl(t)
	natsCalled := false
	fakeHealth(t, nil, func() error { natsCalled = true; return errors.New("no responders") })
	if err := waitHealthy(healthTarget{Version: "v1.66.0", Legacy: true, Timeout: 50 * time.Millisecond, Interval: 10 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if natsCalled || len(*calls) == 0 || (*calls)[0] != "is-active --quiet hsi-worker.service" {
		t.Fatalf("nats called %v, systemctl %v", natsCalled, *calls)
	}
}

func healthServer(t *testing.T, code *int, body *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(*code)
		_, _ = w.Write([]byte(*body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHttpHealthRejectsWrongVersionAndDbDown(t *testing.T) {
	code, body := 200, `{"status":"ok","nats":true,"db":true,"version":"v2.1.0"}`
	srv := healthServer(t, &code, &body)
	target := healthTarget{URL: srv.URL + "/health", Version: "v2.1.0", Timeout: time.Second}
	if err := httpHealth(target); err != nil {
		t.Fatalf("healthy server refused: %v", err)
	}

	body = `{"status":"ok","nats":true,"db":true,"version":"v2.0.0"}`
	if err := httpHealth(target); err == nil || !strings.Contains(err.Error(), "v2.0.0") {
		t.Fatalf("want a version mismatch, got %v", err)
	}

	body = `{"status":"ok","nats":true,"db":false,"version":"v2.1.0"}`
	if err := httpHealth(target); err == nil || !strings.Contains(err.Error(), "database") {
		t.Fatalf("want a database error, got %v", err)
	}

	code, body = 503, `{"status":"degraded","nats":true,"db":false,"version":"v2.1.0"}`
	if err := httpHealth(target); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("want an HTTP status error, got %v", err)
	}

	// The shape of a version before the contract: accepted only for a legacy target.
	code, body = 200, `{"status":"ok","nats":true}`
	if err := httpHealth(target); err == nil {
		t.Fatal("a reply without version accepted")
	}
	target.Legacy = true
	if err := httpHealth(target); err != nil {
		t.Fatalf("legacy reply refused: %v", err)
	}
}

func TestHttpHealthHTTPSUsesTheGivenAuthority(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok","nats":true,"db":true,"version":"v2.1.0"}`))
	}))
	defer srv.Close()
	target := healthTarget{URL: srv.URL + "/health", Version: "v2.1.0", Timeout: time.Second}
	if err := httpHealth(target); err == nil {
		t.Fatal("an unknown certificate was trusted")
	}
	ca := filepath.Join(t.TempDir(), "ca.crt")
	mustWrite(t, ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))
	target.CAFile = ca
	if err := httpHealth(target); err != nil {
		t.Fatal(err)
	}
}

func TestHealthTargetFollowsTLSConfig(t *testing.T) {
	e := setupUpdateEnv(t)
	tg := healthTargetFor("v2.1.0")
	if tg.URL != "http://127.0.0.1:9001/health" || tg.CAFile != "" || tg.Legacy {
		t.Fatalf("default target %+v", tg)
	}
	mustWrite(t, filepath.Join(e.tls, "tls.json"), []byte(`{"mode":"local","port":9443}`))
	tg = healthTargetFor("v2.1.0")
	if tg.URL != "https://127.0.0.1:9443/health" || tg.CAFile != filepath.Join(e.tls, "ca.crt") {
		t.Fatalf("local https target %+v", tg)
	}
	if !healthTargetFor("v1.66.0").Legacy || healthTargetFor("v1.67.0").Legacy {
		t.Fatal("legacy detection")
	}
}

func TestRootHealthReply(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(rootHealthReply(), &got); err != nil {
		t.Fatal(err)
	}
	if got["ok"] != true || got["version"] != buildVersion {
		t.Fatalf("reply %v", got)
	}
}

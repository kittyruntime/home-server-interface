package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stubTLS(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "tls")
	t.Setenv("HSI_TLS_DIR", dir)
	oldAddrs, oldHost, oldGroup := hostAddrs, hostHostname, tlsAppGroup
	hostAddrs = func() []net.IP { return []net.IP{net.ParseIP("192.168.1.48")} }
	hostHostname = func() string { return "nas" }
	tlsAppGroup = func() (int, error) { return os.Getgid(), nil }
	t.Cleanup(func() { hostAddrs, hostHostname, tlsAppGroup = oldAddrs, oldHost, oldGroup })
	return dir
}

func TestIssueServerCertNamesLifetimesAndModes(t *testing.T) {
	dir := stubTLS(t)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	info, err := issueServerCert(currentTLSNames(), now)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"127.0.0.1", "192.168.1.48", "::1", "localhost", "nas", "nas.local"}
	if strings.Join(info.Names, ",") != strings.Join(want, ",") {
		t.Fatalf("names %v", info.Names)
	}
	if got := info.NotAfter.Sub(now); got != 397*24*time.Hour {
		t.Fatalf("server lifetime %v", got)
	}
	if !info.FromAuthority {
		t.Fatal("issued by the local authority")
	}
	ca, _, err := ensureAuthority(now)
	if err != nil || ca.NotAfter.Sub(now) < 3650*24*time.Hour-time.Hour || !ca.IsCA {
		t.Fatalf("authority %v %v", ca, err)
	}
	for name, perm := range map[string]os.FileMode{"ca.key": 0o600, "ca.crt": 0o644, "server.crt": 0o644, "server.key": 0o640} {
		st, err := os.Stat(filepath.Join(dir, name))
		if err != nil || st.Mode().Perm() != perm {
			t.Fatalf("%s: %v %v", name, st, err)
		}
	}
}

func TestEnsureAuthorityIsKept(t *testing.T) {
	stubTLS(t)
	now := time.Now()
	a, _, _ := ensureAuthority(now)
	b, _, _ := ensureAuthority(now.Add(time.Hour))
	if !a.Equal(b) {
		t.Fatal("the authority is created once and then reused")
	}
	fp, err := authorityFingerprint()
	if err != nil || len(fp) != 95 || strings.Count(fp, ":") != 31 {
		t.Fatalf("fingerprint %q %v", fp, err)
	}
}

// selfSigned makes a leaf for import tests.
func selfSigned(t *testing.T, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "nas.example.com"},
		DNSNames: []string{"nas.example.com"}, NotBefore: notAfter.Add(-48 * time.Hour), NotAfter: notAfter,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kd, _ := x509.MarshalECPrivateKey(k)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd})
}

func TestValidateImport(t *testing.T) {
	now := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	cert, key := selfSigned(t, now.Add(90*24*time.Hour))
	info, chain, k, err := validateImport(cert, key, now)
	if err != nil || len(chain) == 0 || len(k) == 0 || info.Names[0] != "nas.example.com" {
		t.Fatalf("valid import refused: %v", err)
	}
	if _, _, _, err := validateImport(append(append([]byte{}, cert...), key...), nil, now); err != nil {
		t.Fatalf("certificate and key in one file: %v", err)
	}
	expired, ekey := selfSigned(t, now.Add(-time.Hour))
	if _, _, _, err := validateImport(expired, ekey, now); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired: %v", err)
	}
	_, otherKey := selfSigned(t, now.Add(90*24*time.Hour))
	if _, _, _, err := validateImport(cert, otherKey, now); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("wrong key: %v", err)
	}
	if _, _, _, err := validateImport(cert, nil, now); err == nil || !strings.Contains(err.Error(), "private key") {
		t.Fatalf("no key: %v", err)
	}
	if _, _, _, err := validateImport([]byte("garbage"), key, now); err == nil {
		t.Fatal("unparsable certificate")
	}
}

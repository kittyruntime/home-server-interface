package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Managed HTTPS (#12): certificates.
// A local authority, created once and only readable by root, signs the
// server certificate the backend serves. An imported certificate replaces the
// server files; the authority stays for a later return to local mode.

func tlsDir() string { return envOr("HSI_TLS_DIR", "/var/lib/hsi/tls") }

const (
	authorityLifetime = 3650 * 24 * time.Hour
	serverLifetime    = 397 * 24 * time.Hour
)

type tlsNames struct {
	DNS []string
	IPs []net.IP
}

func (n tlsNames) list() []string {
	out := append([]string{}, n.DNS...)
	for _, ip := range n.IPs {
		out = append(out, ip.String())
	}
	sort.Strings(out)
	return out
}

var hostAddrs = func() []net.IP {
	addrs, _ := net.InterfaceAddrs()
	var ips []net.IP
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			ips = append(ips, n.IP)
		}
	}
	return ips
}

var tlsAppGroup = defaultTLSAppGroup

// defaultTLSAppGroup resolves the group allowed to read server.key: the one
// stored in tls.json (the installer records the application user's primary
// group), else HSI_APP_GROUP, else "hsi".
func defaultTLSAppGroup() (int, error) {
	name := loadTLSConfig().Group
	if name == "" {
		name = envOr("HSI_APP_GROUP", "hsi")
	}
	g, err := user.LookupGroup(name)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(g.Gid)
}

func currentTLSNames() tlsNames {
	n := tlsNames{DNS: []string{"localhost"}, IPs: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	if h := hostHostname(); h != "" {
		n.DNS = append(n.DNS, h, h+".local")
	}
	n.IPs = append(n.IPs, hostAddrs()...)
	return n
}

type certInfo struct {
	Subject       string    `json:"subject"`
	Issuer        string    `json:"issuer"`
	Names         []string  `json:"names"`
	NotBefore     time.Time `json:"notBefore"`
	NotAfter      time.Time `json:"notAfter"`
	Fingerprint   string    `json:"fingerprint"`
	FromAuthority bool      `json:"fromAuthority"`
}

func fingerprintOf(der []byte) string {
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":")
}

func infoOf(c *x509.Certificate) certInfo {
	names := append([]string{}, c.DNSNames...)
	for _, ip := range c.IPAddresses {
		names = append(names, ip.String())
	}
	sort.Strings(names)
	info := certInfo{Subject: c.Subject.CommonName, Issuer: c.Issuer.CommonName, Names: names,
		NotBefore: c.NotBefore, NotAfter: c.NotAfter, Fingerprint: fingerprintOf(c.Raw)}
	if ca, err := os.ReadFile(filepath.Join(tlsDir(), "ca.crt")); err == nil {
		if b, _ := pem.Decode(ca); b != nil {
			if root, err := x509.ParseCertificate(b.Bytes); err == nil && c.CheckSignatureFrom(root) == nil {
				info.FromAuthority = true
			}
		}
	}
	return info
}

func readCertInfo(certPEM []byte) (certInfo, error) {
	b, _ := pem.Decode(certPEM)
	if b == nil || b.Type != "CERTIFICATE" {
		return certInfo{}, errors.New("no certificate in the file")
	}
	c, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return certInfo{}, err
	}
	return infoOf(c), nil
}

func randomSerial() *big.Int {
	n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	return n
}

// writeTLSFile writes name in the TLS directory with exactly perm. With group
// set, the file is handed to the application group (the owner is kept).
func writeTLSFile(name string, data []byte, perm os.FileMode, group bool) error {
	dir := tlsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	p := filepath.Join(dir, name)
	if err := writeFileAtomic(p, data, perm); err != nil {
		return err
	}
	if err := os.Chmod(p, perm); err != nil {
		return err
	}
	if group {
		gid, err := tlsAppGroup()
		if err != nil {
			return fmt.Errorf("the application group: %w", err)
		}
		return os.Chown(p, -1, gid)
	}
	return nil
}

func ensureAuthority(now time.Time) (*x509.Certificate, *ecdsa.PrivateKey, error) {
	dir := tlsDir()
	certPEM, cerr := os.ReadFile(filepath.Join(dir, "ca.crt"))
	keyPEM, kerr := os.ReadFile(filepath.Join(dir, "ca.key"))
	if cerr == nil && kerr == nil {
		cb, _ := pem.Decode(certPEM)
		kb, _ := pem.Decode(keyPEM)
		if cb != nil && kb != nil {
			c, err1 := x509.ParseCertificate(cb.Bytes)
			k, err2 := x509.ParseECPrivateKey(kb.Bytes)
			if err1 == nil && err2 == nil {
				return c, k, nil
			}
		}
		return nil, nil, errors.New("the local authority files are unreadable: move them away to create a new authority")
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	host := hostHostname()
	tpl := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: "HSI local authority (" + host + ")"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(authorityLifetime),
		IsCA: true, BasicConstraintsValid: true, MaxPathLenZero: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		return nil, nil, err
	}
	kd, _ := x509.MarshalECPrivateKey(k)
	if err := writeTLSFile("ca.key", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), 0o600, false); err != nil {
		return nil, nil, err
	}
	if err := writeTLSFile("ca.crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644, false); err != nil {
		return nil, nil, err
	}
	c, _ := x509.ParseCertificate(der)
	return c, k, nil
}

func issueServerCert(names tlsNames, now time.Time) (certInfo, error) {
	ca, caKey, err := ensureAuthority(now)
	if err != nil {
		return certInfo{}, err
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return certInfo{}, err
	}
	cn := "localhost"
	if len(names.DNS) > 1 {
		cn = names.DNS[1]
	}
	tpl := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: cn},
		DNSNames: names.DNS, IPAddresses: names.IPs,
		NotBefore: now, NotAfter: now.Add(serverLifetime),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca, &k.PublicKey, caKey)
	if err != nil {
		return certInfo{}, err
	}
	kd, _ := x509.MarshalECPrivateKey(k)
	// The key first: a certificate never names a key that is not there yet.
	if err := writeTLSFile("server.key", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kd}), 0o640, true); err != nil {
		return certInfo{}, err
	}
	chain := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := writeTLSFile("server.crt", chain, 0o644, false); err != nil {
		return certInfo{}, err
	}
	c, _ := x509.ParseCertificate(der)
	return infoOf(c), nil
}

// validateImport checks an imported certificate: a parsable chain, a private
// key matching the leaf (in keyPEM or in certPEM), a leaf still valid and
// usable by a server. It returns the chain and key to write as they are.
func validateImport(certPEM, keyPEM []byte, now time.Time) (certInfo, []byte, []byte, error) {
	var chain, key []byte
	var leaf *x509.Certificate
	rest := append(append([]byte{}, certPEM...), keyPEM...)
	for {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		switch {
		case b.Type == "CERTIFICATE":
			c, err := x509.ParseCertificate(b.Bytes)
			if err != nil {
				return certInfo{}, nil, nil, fmt.Errorf("a certificate in the file cannot be read: %w", err)
			}
			if leaf == nil {
				leaf = c
			}
			chain = append(chain, pem.EncodeToMemory(b)...)
		case strings.HasSuffix(b.Type, "PRIVATE KEY"):
			if key == nil {
				key = pem.EncodeToMemory(b)
			}
		}
	}
	if leaf == nil {
		return certInfo{}, nil, nil, errors.New("no certificate found: expected a PEM file (-----BEGIN CERTIFICATE-----)")
	}
	if key == nil {
		return certInfo{}, nil, nil, errors.New("no private key found: add the key file, or a file holding both")
	}
	if _, err := tlsKeyPair(chain, key); err != nil {
		return certInfo{}, nil, nil, errors.New("the private key does not match the certificate")
	}
	if now.After(leaf.NotAfter) {
		return certInfo{}, nil, nil, fmt.Errorf("this certificate expired on %s", leaf.NotAfter.Format("2006-01-02"))
	}
	if len(leaf.ExtKeyUsage) > 0 && !containsEKU(leaf.ExtKeyUsage, x509.ExtKeyUsageServerAuth) {
		return certInfo{}, nil, nil, errors.New("this certificate is not for a server (no server authentication usage)")
	}
	return infoOf(leaf), chain, key, nil
}

func containsEKU(list []x509.ExtKeyUsage, u x509.ExtKeyUsage) bool {
	for _, x := range list {
		if x == u {
			return true
		}
	}
	return false
}

func authorityFingerprint() (string, error) {
	b, err := os.ReadFile(filepath.Join(tlsDir(), "ca.crt"))
	if err != nil {
		return "", err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return "", errors.New("ca.crt is not a PEM certificate")
	}
	return fingerprintOf(blk.Bytes), nil
}

// tlsKeyPair is crypto/tls.X509KeyPair: it fails when the key does not match the leaf.
func tlsKeyPair(certPEM, keyPEM []byte) (tls.Certificate, error) {
	return tls.X509KeyPair(certPEM, keyPEM)
}

package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// releaseSigningPub is the PEM public key that signs SHA256SUMS. A copy lives in
// scripts/release-signing.pub and in the scripts/install.sh heredoc; a test keeps them equal.
//
//go:embed release-signing.pub
var releaseSigningPub []byte

// devKeyFingerprint is the sha256 of the raw development public key. That key's private half
// is committed under testdata, so a build that embeds it must not trust releases.
const devKeyFingerprint = "0c9fde95a7afa23901ce53c94613f8f7a710af273942f2e7ff9aa86941cd4e7a"

const (
	// releaseDownloadTimeout bounds each request, not the whole download.
	releaseDownloadTimeout = 15 * time.Minute
	releaseDownloadMax     = 1 << 30
)

// Size caps for the small signed files, checked on download and before reading.
var (
	sumsMaxBytes int64 = 64 << 10
	sigMaxBytes  int64 = 64 << 10
)

// releaseTransport is nil in production (default transport); tests inject one.
var releaseTransport http.RoundTripper

var (
	releaseVersionRe = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)
	sumsLineRe       = regexp.MustCompile(`^([0-9a-fA-F]{64})  ([^/\s]+)$`)
)

func checkReleaseVersion(version string) error {
	if !releaseVersionRe.MatchString(version) {
		return fmt.Errorf("invalid release version %q", version)
	}
	return nil
}

// checkTrustedKey refuses the development key unless HSI_ALLOW_DEV_SIGNING_KEY=1.
func checkTrustedKey(pub ed25519.PublicKey) error {
	h := sha256.Sum256(pub)
	if hex.EncodeToString(h[:]) == devKeyFingerprint && os.Getenv("HSI_ALLOW_DEV_SIGNING_KEY") != "1" {
		return fmt.Errorf("the release signing key is a development key, refusing to trust releases signed by it")
	}
	return nil
}

// insecureReleaseURLAllowed reports whether HSI_RELEASE_BASE_URL explicitly sets an http URL (tests).
func insecureReleaseURLAllowed() bool {
	return strings.HasPrefix(os.Getenv("HSI_RELEASE_BASE_URL"), "http://")
}

func readSmallFile(path string, max int64) ([]byte, error) {
	fh, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	if st, err := fh.Stat(); err == nil && st.Size() > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", filepath.Base(path), max)
	}
	b, err := io.ReadAll(io.LimitReader(fh, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s is larger than %d bytes", filepath.Base(path), max)
	}
	return b, nil
}

// parseSums strictly parses SHA256SUMS into name -> lowercase hex hash.
func parseSums(sums []byte) (map[string]string, error) {
	listed := map[string]string{}
	// Split on "\n" only: a scanner would silently drop the "\r" of CRLF lines.
	lines := strings.Split(string(sums), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for _, line := range lines {
		m := sumsLineRe.FindStringSubmatch(line)
		if m == nil {
			return nil, fmt.Errorf("malformed line in SHA256SUMS")
		}
		if _, dup := listed[m[2]]; dup {
			return nil, fmt.Errorf("%s is listed twice in SHA256SUMS", m[2])
		}
		listed[m[2]] = strings.ToLower(m[1])
	}
	return listed, nil
}

var releaseBaseURL = envOr("HSI_RELEASE_BASE_URL", "https://github.com/kittyruntime/home-server-interface/releases/download")

// releaseFiles holds the local paths of a downloaded release.
type releaseFiles struct{ Sums, Sig, Archive, Installer string }

func releasePublicKey() (ed25519.PublicKey, error) {
	block, _ := pem.Decode(releaseSigningPub)
	if block == nil {
		return nil, fmt.Errorf("release signing key is not PEM")
	}
	k, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("release signing key: %w", err)
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("release signing key is not ed25519")
	}
	return pub, nil
}

func archiveName(version string) string {
	return unitPrefix() + "-" + version + "-linux-amd64.tar.gz"
}

// verifyRelease checks the signature over Sums, then the sha256 of Archive and
// Installer against it. It never modifies files.
func verifyRelease(pub ed25519.PublicKey, f releaseFiles, version string) error {
	if err := checkReleaseVersion(version); err != nil {
		return err
	}
	if err := checkTrustedKey(pub); err != nil {
		return err
	}
	sums, err := readSmallFile(f.Sums, sumsMaxBytes)
	if err != nil {
		return fmt.Errorf("read SHA256SUMS: %w", err)
	}
	sigText, err := readSmallFile(f.Sig, sigMaxBytes)
	if err != nil {
		return fmt.Errorf("read SHA256SUMS.sig: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigText)))
	if err != nil {
		return fmt.Errorf("SHA256SUMS.sig is not base64: %w", err)
	}
	if len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, sums, sig) {
		return fmt.Errorf("SHA256SUMS signature is invalid")
	}
	listed, err := parseSums(sums)
	if err != nil {
		return err
	}
	for name, path := range map[string]string{archiveName(version): f.Archive, "install.sh": f.Installer} {
		want, ok := listed[name]
		if !ok {
			return fmt.Errorf("%s is not listed in SHA256SUMS", name)
		}
		got, err := fileSHA256(path)
		if err != nil {
			return err
		}
		if got != want {
			return fmt.Errorf("%s does not match SHA256SUMS", name)
		}
	}
	return nil
}

func fileSHA256(path string) (string, error) {
	fh, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer fh.Close()
	h := sha256.New()
	if _, err := io.Copy(h, fh); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// downloadRelease fetches SHA256SUMS, SHA256SUMS.sig, the archive and install.sh of
// version into dir.
var downloadRelease = func(version, dir string) (releaseFiles, error) {
	if err := checkReleaseVersion(version); err != nil {
		return releaseFiles{}, err
	}
	insecure := insecureReleaseURLAllowed()
	if !insecure && !strings.HasPrefix(releaseBaseURL, "https://") {
		return releaseFiles{}, fmt.Errorf("release base URL must be https")
	}
	f := releaseFiles{
		Sums:      filepath.Join(dir, "SHA256SUMS"),
		Sig:       filepath.Join(dir, "SHA256SUMS.sig"),
		Archive:   filepath.Join(dir, archiveName(version)),
		Installer: filepath.Join(dir, "install.sh"),
	}
	client := &http.Client{
		Timeout:   releaseDownloadTimeout,
		Transport: releaseTransport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != "https" && !insecure {
				return fmt.Errorf("refusing redirect to non-https URL")
			}
			return nil
		},
	}
	base := strings.TrimRight(releaseBaseURL, "/") + "/" + version + "/"
	caps := map[string]int64{f.Sums: sumsMaxBytes, f.Sig: sigMaxBytes, f.Archive: releaseDownloadMax, f.Installer: releaseDownloadMax}
	for _, p := range []string{f.Sums, f.Sig, f.Archive, f.Installer} {
		if err := fetchReleaseFile(client, base+filepath.Base(p), p, caps[p]); err != nil {
			return releaseFiles{}, err
		}
	}
	return f, nil
}

func fetchReleaseFile(client *http.Client, url, dest string, max int64) error {
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", filepath.Base(dest), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", filepath.Base(dest), resp.StatusCode)
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, max+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("download %s: %w", filepath.Base(dest), err)
	}
	if n > max {
		return fmt.Errorf("download %s: larger than the size cap", filepath.Base(dest))
	}
	return nil
}

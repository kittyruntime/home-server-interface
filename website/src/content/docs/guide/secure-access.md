---
title: Secure access (HTTPS)
description: How HSI serves HTTPS, trusting its local authority, importing a certificate, running behind a reverse proxy, and recovering access.
---

HSI serves its interface over HTTPS on its own port (`BACKEND_PORT`, 9001 by default).
Plain HTTP on that port answers with a 308 redirect to the same address over HTTPS.
Everything is managed in Settings > Secure access, and in the first-run setup
assistant, which has a Secure access step (mode, fingerprint, authority download and
the steps to trust it).

## The four modes

| Mode | What it does |
|---|---|
| Local | HTTPS with a certificate issued by a local authority that HSI creates. Default for new installations. |
| Imported | HTTPS with a certificate you import (for example one for your own domain). |
| Proxy | HSI speaks plain HTTP behind your reverse proxy, which handles HTTPS. You list the trusted proxies. |
| Off | Plain HTTP. Where existing installations stay until you switch. |

### Local authority

On first start HSI creates an authority (ECDSA P-256, valid 10 years) and a server
certificate signed by it. The server certificate lasts 397 days and covers the
hostname, `hostname.local`, the server's IP addresses and `localhost`. The daily
check renews it when fewer than 30 days remain, or when the names or IPs of the
server change.

Browsers warn until they trust the authority. The authority certificate is public:
download it without signing in at `https://<server>:9001/ca.crt` (saved as
`hsi-authority.crt`), or from Settings > Secure access.

## Check the fingerprint, then trust the authority

Before trusting the authority, check that the file is the right one. The installer
prints the SHA-256 fingerprint; you can print it again on the server:

```bash
sudo hsi-worker tls fingerprint
```

Compare it with the fingerprint shown by your system when you open the file. Then
install `hsi-authority.crt` on each device:

- **Windows**: double-click the file, choose Install Certificate, Local Machine, then
  place it in "Trusted Root Certification Authorities".
- **macOS**: open it in Keychain Access, add it to the System keychain, then set it
  to Always Trust.
- **Linux**: `sudo cp hsi-authority.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.
  Firefox has its own store: import it in Settings > Privacy & Security > Certificates.
- **Android**: Settings > Security > Install a certificate > CA certificate.
- **iOS**: open the file and install the profile, then Settings > General > About >
  Certificate Trust Settings, and enable full trust for it.

Restart the browser afterwards.

## Import a certificate

In Settings > Secure access, import a certificate in PEM format: the chain and the
key, as separate files or in a single file. HSI refuses a certificate that is
expired, has no key, has a key that does not match, cannot be read, or is not meant
for server use. The preview warns when the certificate does not cover the server's
names, so you can check before applying. The new certificate is served without
restarting HSI.

HSI notifies you 30 days and 7 days before an imported certificate expires, and
when it expires. If an imported certificate is broken at start, HSI switches back to
the local authority and sends an alert.

## Behind a reverse proxy

In Proxy mode HSI listens in plain HTTP and your reverse proxy provides HTTPS. List
the proxies it should trust (IP addresses or CIDR ranges); loopback is always
trusted. Only requests from trusted proxies are allowed to set the forwarded headers
(`X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`) that HSI uses to know
the client address and the original scheme and host. The proxy must reach HSI from an
address in that list: its own IP (for example 192.168.1.20 when it runs on another
host), or the Docker network CIDR when it runs as a container.

Caddy:

```
hsi.example.com {
    reverse_proxy http://192.168.1.20:9001
}
```

Traefik (file provider):

```yaml
http:
  routers:
    hsi:
      rule: Host(`hsi.example.com`)
      entryPoints: [websecure]
      tls: {}
      service: hsi
  services:
    hsi:
      loadBalancer:
        servers:
          - url: http://192.168.1.20:9001
```

Both forward the headers and WebSocket upgrades by default.

## Ports 443 and 80

Settings > Secure access can also serve HTTPS on port 443, with port 80 redirecting
to it, so that `https://<server>/` works without a port. HSI refuses to turn this on
when 443 or 80 is already in use, and names what holds the port (a container, for
example). If a port is taken later, after the option was turned on, HSI only logs it
at start and keeps serving on its own port.

## Existing installations

An update never switches an existing installation:

- With the nginx site of older versions, it is in Proxy mode and the site is kept.
  To move to direct HTTPS, turn HTTPS on in Settings > Secure access, then remove
  both files of the site and reload nginx (an update regenerates the site only
  while it is enabled and HSI is in Proxy mode):

  ```bash
  sudo rm /etc/nginx/sites-enabled/hsi /etc/nginx/sites-available/hsi
  sudo systemctl reload nginx
  ```

- Without nginx, it stays in plain HTTP (Off) and a banner offers to turn HTTPS on.

New installations no longer install or configure nginx.

## Files

HSI keeps its HTTPS files in `/var/lib/hsi/tls/` (override with `HSI_TLS_DIR`); see
[TLS files](/home-server-interface/reference/configuration/#tls-files). The local
authority's private key never leaves that directory.

## Backups

A configuration backup carries `tls.json` and an imported certificate, never the
local authority. A restore on another server creates that server's own authority.
See [Backup and restore](/home-server-interface/guide/backup-restore/).

## Recovery

If you cannot reach HSI after a change (a bad import, a wrong proxy setting), run on
the server:

```bash
sudo hsi-worker tls reset
```

It sets Local mode on the HSI port, issues a new certificate, turns 443 and 80 off,
restarts `hsi-server`, and prints the URL and the fingerprint.

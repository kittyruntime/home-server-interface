---
title: Connect an AI assistant
description: Let Claude or another MCP client look after the NAS with an access token, within your own rights.
---

HSI is an [MCP](https://modelcontextprotocol.io) server: an AI assistant such as
Claude can browse your files and check apps, storage, accounts and backups, in
plain language ("why is the RAID degraded?", "what takes the most space in
Downloads?"). The assistant acts as you, with an access token: it never gets
more rights than your account, and every check of the dashboard applies.

## Create an access token

In **Settings > AI access**, choose **New access token**:

- **Name**: what the token is for, such as "Claude on my laptop".
- **What the assistant may do**: read or change, for files, apps, storage, users
  and sharing, and the system. A new token is read-only. A token never goes
  beyond your account: an apps scope on a non-admin account gives nothing, since
  only admins manage apps.
- **Expires**: after 7, 30, 90 or 365 days, or never.

The token (`hsi_pat_…`) is shown once: copy it then. The list shows each token's
scopes and when it was last used. **Revoke** cuts its access at once. An admin
also sees the other accounts' tokens and can revoke them.

A token cannot create or revoke tokens, change the password, or sign in to the
dashboard. The dashboard's own sessions are not accepted by the MCP endpoint
either.

## Connect the assistant

The endpoint is `https://<server>:9001/mcp` (Streamable HTTP), with the header
`Authorization: Bearer <token>`.

The assistant's computer must trust HSI's certificate. With the local authority
(the default), download it from `https://<server>:9001/ca.crt` (see
[Secure access](/home-server-interface/guide/secure-access/)), then point Node-based clients at it with
`NODE_EXTRA_CA_CERTS`.

**Claude Code**: Settings > AI access shows the command with your token:

```sh
export NODE_EXTRA_CA_CERTS=~/hsi-authority.crt
claude mcp add --transport http hsi https://nas.local:9001/mcp \
  --header "Authorization: Bearer hsi_pat_…"
```

**Claude Desktop**, through the `mcp-remote` bridge, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hsi": {
      "command": "npx",
      "args": ["mcp-remote", "https://nas.local:9001/mcp", "--header", "Authorization:${HSI_AUTH}"],
      "env": {
        "HSI_AUTH": "Bearer hsi_pat_…",
        "NODE_EXTRA_CA_CERTS": "/Users/me/hsi-authority.crt"
      }
    }
  }
}
```

Other MCP clients connect the same way: the URL and the header.

## What the assistant can use

Each tool needs a scope, and some need admin rights (or the storage capability).
The assistant is only offered the tools its token and account allow.

| Scope | Tools |
| --- | --- |
| Files, read | List Places, list a folder, file details, read a text file (cut after 200,000 characters, binary files refused), search files by name, folder size |
| Apps, read | App Store catalog; for admins: apps and their state, an app's settings (passwords and keys masked), the last lines of a container's logs |
| Storage, read | With the storage capability: disks, filesystems, RAID and volumes, S.M.A.R.T. health, LVM, alerts |
| Users, read | Accounts; for admins: groups, who can access a Place, SMB shares |
| System, read | CPU, memory and network; for admins: system information, backups, HSI updates, the audit log |

## Safety

- **Same rights as you**: files are read as your Linux account, so a non-admin's
  assistant only sees that account's Places. A demoted account loses the matching
  tools at its next request.
- **Audited**: what an assistant changes is in the audit log (Monitor > Audit log),
  marked as coming from an AI assistant, with the token used. Reading a file,
  searching files and reading logs are recorded too. Filter the log by **AI
  assistant** to see only what assistants did.
- **Maintenance**: during an update or a restart, nothing can be changed, by an
  assistant either.
- **Limits**: 120 requests per minute and token.
- **Privacy**: what the assistant reads (file contents, logs, names) goes to the
  service that runs it. Use a local model, or give the token only what it needs.
- **Instructions in files**: a file or a log can contain text written to trick
  an assistant ("delete everything"). HSI tells the assistant to treat what it
  reads as data, and keeps tokens read-only by default.

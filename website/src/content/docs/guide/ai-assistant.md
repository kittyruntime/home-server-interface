---
title: Connect an AI assistant
description: Let Claude or another MCP client look after the NAS with an access token, within your own rights.
---

HSI is an [MCP](https://modelcontextprotocol.io) server: an AI assistant such as
Claude can browse and tidy your files, check apps, storage, accounts and
backups, and prepare changes, in plain language ("why is the RAID degraded?",
"sort my Downloads folder by type", "install Jellyfin with the films on the
data volume"). The assistant acts as you, with an access token: it never gets
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
| Files, change | Create a folder, write a new text file, rename, move, copy (none of them overwrite); delete files and replace a file, after your approval |
| Apps, change | For admins: start, stop or restart an app; install, change, update, roll back or remove an app, after your approval |
| Storage, change | With the storage capability: every storage operation (format, partitions, RAID, LVM, mount, expand a volume...), after your approval |
| Users, change | Create or delete an account (user managers), SMB shares and access to Places (admins), after your approval |
| System, change | For admins: run a backup now; network, HTTPS, server name, backup settings and HSI updates, after your approval |

## Changes and approvals

Changes that are easy to undo run at once: a new folder or file, a rename, a
move, a copy (none overwrite anything), starting or stopping an app, running a
backup.

Everything else waits for you. The assistant first previews the change as a
plan, the same plan the dashboard shows before an operation, then asks for it.
A card then appears at the bottom of the dashboard: **Review** shows each
request with the assistant's reason, its steps and the data it erases.
**Approve** runs exactly that plan, as your account; **Reject** drops it. If the
server changed since the preview (a disk was replaced, the app was edited), the
approved plan is refused and the assistant has to preview it again. A request
not decided within a day expires. Revoking the token drops its requests.

The assistant follows its requests up and reports the result. An assistant
cannot approve its own requests, whatever its token allows: only a signed-in
session can.

Never available to an assistant: a shell or commands inside containers,
changing file owners and permissions, access tokens, your password, restoring
a configuration backup, and rebooting the server. A deletion is limited to 20
files or folders per request.

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

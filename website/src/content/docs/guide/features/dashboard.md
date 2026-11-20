---
title: Dashboard
description: Boards of widgets on the Overview and the desktop, kept on your account.
sidebar:
  order: 0
---

The Overview shows **boards**: named tabs of widgets. The same boards appear
behind the windows in desktop mode. They are kept on your account, so they
follow you from one browser or device to another.

## Editing

Select **Edit**. In edit mode you can:

- **move** a widget by its handle, with the mouse, a finger or the arrow keys
  once the handle has the focus;
- give it a size: **S** (one column), **M** (two columns) or **L** (two
  columns, two rows);
- open its **settings** to change its title, and what it shows when it offers
  a choice (a measure, a period, a note, links);
- **remove** it, or **add a widget** from the catalog.

The bar above the widgets renames the open board, moves it, removes it or adds
another one (up to 12). The **…** menu brings your boards back to the default.

An admin can **publish** the boards for every account: an account without boards
of its own starts from the published ones, and gets its own copy the first time
it changes something. Accounts that already have their own boards keep them.

## Status line

Above the widgets, a line says whether anything needs attention: critical alerts,
then other alerts (disks, arrays, space, backups, certificate), then an HSI update.
**See** opens where to act. It is shown to admins and to accounts with the
storage permission.

## Widgets

| Widget | Shows | Who |
|---|---|---|
| CPU, Memory, Network | Live use and the last two minutes | Everyone |
| History | CPU, memory or network over 24 hours or 7 days, with average and peak | Admins |
| Temperatures | Processor, disk and board temperatures, fan speeds (from the kernel's sensors) | Everyone |
| UPS | Charge, runtime, mains or battery, through Network UPS Tools when it is installed | Everyone |
| Who uses the server | Apps, accounts, HSI and the system ranked by CPU, memory or disk | Admins |
| Today on the server | A few sentences from the assistant on the alerts, failed tasks and refused sign-ins. Written when you ask, kept for the day, counted in the assistant's daily limit | Admins |
| Alerts | Active alerts, critical first | Storage |
| Volumes | State and free space of each volume | Storage |
| Disk health | SMART health and temperature of each disk, read without waking a sleeping disk | Storage |
| Space forecast | When each volume will be full at its pace of the last 30 days. HSI records the space used every hour; an estimate comes after a day | Storage |
| Backups | Last run and result of each plan, next run | Admins |
| Trash | What the trash of each place you can delete in holds | Everyone |
| Apps | Running, stopped and failing apps, updates, a link to each app's page | Admins |
| Updates and HTTPS | HSI version, app updates, certificate expiry | Admins |
| Activity | Copies, moves and other tasks running now | Everyone |
| Sharing | People connected to shares, active shared links | Everyone (their own) |
| Journal | Latest sign-ins and admin actions, refused sign-ins of the day | Admins |
| My places | Your places; a click opens one in Files | Everyone |
| Note | Free text in Markdown | Everyone |
| Links | Shortcuts to your services. For admins, HSI checks from the server that each one answers | Everyone |

A widget whose data cannot be read says so in its last line; one whose data
is old says that too.

## Custom widgets

A **Custom** widget shows any value you can reach: a service's API, a script, or
a server command. It reads one to three **sources** (`$1`, `$2`, `$3`).

### Sources

Admins create sources from the widget's settings, from a template or from
scratch. HSI reads them, not your browser, so a plain `http://` service on your
network works whatever address you use for HSI, and API keys never reach the
browser.

| Kind | How it gets its data |
|---|---|
| Address read by HSI | HSI calls a `GET` address every interval (30 seconds at least) with the headers you set. `127.0.0.1` is the server itself. JSON answers are kept as they are, text as `{ "text": ... }`. Answers over 256 KB are refused. |
| Sent by a script | A script sends JSON to HSI (see below). |
| Server command | One of a fixed list of read-only commands, run by HSI without a shell: disks (`lsblk`), network addresses (`ip addr`), failed services (`systemctl`), sensors (`sensors`), ZFS pools (`zpool list`), RAID arrays (`/proc/mdstat`), container usage (`docker stats`), system errors of the last day (`journalctl`), space per file system (`df`). |

- **Secret headers** (an API key, a token) are encrypted on the server and never
  shown again. If you change the address to another host, port or scheme, enter
  them again.
- **https**: the certificate is checked. For a service with a self-signed
  certificate on your own network, tick **Accept a self-signed certificate**.
- **Who sees its data**: admins only, or every account.
- **Keep as history**: a path to a number HSI keeps for 7 days, for the
  **Figure and curve** display.
- **Raise an alert**: when the value at a path is above, below, equal to or
  different from a value, HSI raises an alert. It shows in Monitor, notifies
  through your notification rules and goes away once the condition is over.
  `{value}` in the message is replaced by the value.

Templates fill in the address and header of Jellyfin, Immich, Nextcloud,
AdGuard Home, Home Assistant and Syncthing (with the app's port when it is
installed from the App Store), and of the server commands, with a widget to
show them. You only paste the API key.

### Sending data from a script

When a "Sent by a script" source is saved, HSI shows its address and token once:

```sh
curl -X POST \
  -H "Authorization: Bearer hsiw_..." \
  -H "Content-Type: application/json" \
  -d '{"temperature": 21.5, "door": "closed"}' \
  https://your-server/api/widgets/push/<source id>
```

The body is any JSON up to 64 KB. Each call replaces the previous value.

### What the widget shows

The **Value** is a path into a source, or a calculation:

| Example | Gives |
|---|---|
| `$1.photos` | The `photos` field of the first source |
| `$1.data.items[0].name` | A field inside a list |
| `$1["odd key"]` | A field whose name has spaces or dashes |
| `$1.used / $1.size * 100` | A calculation: `+ - * /` and parentheses |
| `count($1.sessions, "NowPlayingItem")` | The items where that field is set |
| `sum($1.items, "size")` | Also `avg`, `min`, `max` |

Only arithmetic is evaluated: nothing in a source or an expression is run as code.
In the settings, the right column shows each source's data as a tree: click a
key to write its path in the field you are editing.

- **Formats**: number, percentage, size, rate, duration, relative date, text,
  yes or no; with a prefix, a unit and decimals.
- **Displays**: figure, gauge (with its minimum and maximum), figure and curve,
  state (a word for yes and for no), list (a list path, then each item's name
  and value, where `@` is the item), or text.
- **Thresholds**: a warning and a critical level color the value; tick
  **Lower is worse** for a battery or free space.

## Wall displays

A wall display shows one of your boards on a tablet or a TV, full screen,
without signing in. In the Overview, open the **…** menu, then **Wall
displays…**, and create a display of the open board. HSI shows its link once:
open it on the screen.

- The display only **reads** what its widgets show, as your account, with your
  rights as they are now. It cannot change anything, and cannot reach any other
  part of HSI.
- The token is in the part of the link after `#`, which the browser never sends
  to the server, so it does not appear in logs.
- The screen stays awake while the page is visible, the pointer hides after
  3 seconds, and the board is read again every 5 minutes.
- A display shows a copy of the board: **Show this board** updates it from the
  board as it is now, keeping its link.
- **Remove** a display to stop its link at once, for example if the link leaked.
  An account has up to 10 displays.

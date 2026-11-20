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

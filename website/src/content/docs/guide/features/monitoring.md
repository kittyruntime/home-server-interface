---
title: Monitoring and notifications
description: Live metrics and history, alerts, the audit trail and notification connectors.
sidebar:
  order: 5
  badge: Beta
---

![Monitoring](../../../../assets/monitoring.png)

The Monitor app has five sections: Performance, Processes, History, Alerts and
Audit log.

- **Performance**: every resource in a list on the left, each with a small live
  graph: the CPU, the memory, each disk and each network port. Pick one to see
  its graph over the last two minutes, refreshed every 2 seconds, and its
  figures: usage, speed, processes and threads for the CPU (with a graph per
  core), memory composition and swap, a disk's active time, read and write
  speed, a port's receive and send rates, link speed and addresses.
- **Processes**: every program running on the server, sortable by name, PID,
  user, CPU, memory or disk activity, with a search. The column headers show
  the machine totals and busy cells are shaded. Select a process to see its
  command line, then **End process** asks it to stop; if it keeps running, the
  same button forces it. The system, its kernel threads and the processes that
  run HSI are protected and cannot be ended. Ending a process is recorded in
  the audit trail.
- **History**: CPU, memory and network over 1 hour to 7 days, with the average
  and the peak of each curve.
- **Alerts**: background checks raise alerts for a degraded array, a failing disk,
  a missing volume, a RAID consistency mismatch, a failed backup or update.
  Monitor > Alerts lists them; an alert whose condition is still true comes back
  at the next check.
- **Audit trail**: a filterable log of privileged actions, including every
  executed plan with the result of each step. Entries are kept for a year by
  default: set `retention_days` under `[audit]` in `/etc/hsi/hsi.toml` to
  change it, or to `0` to keep every entry. The change applies within a day.

## Notifications

Settings > Notifications routes alerts to connectors through rules. Each rule
filters by source and minimum severity. A default rule sends all alerts to the
bell menu.

- **In-app**: the bell menu, with an unread badge.
- **Webhooks**: editable JSON payload templates with presets for Discord, Slack,
  ntfy and [SmallTV](https://github.com/giovi321/smalltv-mod) desk screens, a live
  preview and a test send.
- **Email**: SMTP with STARTTLS, TLS or none, presets for Gmail and Fastmail.

Webhook and email messages go through a queue stored in the database: they
survive a restart, are retried, and are rate-limited per connector. Connector
secrets are encrypted. Details are in
[Notifications](/home-server-interface/reference/configuration/#notifications).

HSI can only notify while it is running: use an external monitor to detect that
the server itself is down.

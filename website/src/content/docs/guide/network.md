---
title: Network settings
description: How HSI changes a server's IPv4 address and DNS through NetworkManager, how a change is kept or undone, and how to recover from the console.
---

Settings > Network shows each interface with its current IPv4 address, gateway and DNS
servers, and how it gets them (DHCP or manual). An administrator can switch an interface
between DHCP and a manual address with its gateway, and set the DNS servers.

HSI changes the network through **NetworkManager**. When NetworkManager is not running,
or does not manage an interface with a connection, the page shows the settings and says
why they cannot be changed. Inside a container (LXC, for example) the network belongs to
the container host: set it there.

## Keeping a change

A change is reviewed first, like every other operation, then applied under a
NetworkManager *checkpoint*:

1. NetworkManager saves the current settings.
2. HSI applies the new ones; the connection drops for a moment.
3. The change has to be **kept within two minutes**. If nobody keeps it, NetworkManager
   puts the previous settings back by itself. This does not depend on HSI: it works even
   if the new settings cut the dashboard off, or if HSI's server stopped.

When the change moves the dashboard to another address, the review says which one.
Open it (`https://<new address>:9001`) and go to Settings > Network: the change still
waiting is listed there with **Keep** and **Undo now**. If the new address does not
answer, wait two minutes: the previous address comes back.

## Recovering from the console

On the server itself (keyboard and screen, or a serial console):

```sh
# The interfaces and what NetworkManager does with them
nmcli device status
nmcli connection show

# A change still waiting: undo it now (or wait two minutes)
busctl get-property org.freedesktop.NetworkManager /org/freedesktop/NetworkManager \
  org.freedesktop.NetworkManager Checkpoints
busctl call org.freedesktop.NetworkManager /org/freedesktop/NetworkManager \
  org.freedesktop.NetworkManager CheckpointRollback o /org/freedesktop/NetworkManager/Checkpoint/<n>

# Back to DHCP on a connection
nmcli connection modify "<connection>" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
nmcli connection up "<connection>"
```

Changes made with `nmcli` are seen by HSI as they are: Settings > Network always reads
the server's current state.

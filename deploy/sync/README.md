# Librarium's sync server

Everything colleagues share goes through one server you run: live boards through an Automerge
sync server, library items through Syncthing. Both are reachable only on your Tailscale network;
the Tailscale access policy is the list of who can get in.

## Before you start

1. **Tailscale.** The server is on your Tailscale network, tagged `tag:librarium-sync` (Machines
   ▸ … ▸ Edit ACL tags), with MagicDNS and HTTPS certificates on (DNS page).
2. **The access policy** lets your colleagues reach the server's two ports, and nothing else:

   ```json
   "groups":    { "group:librarium": ["you@example.org"] },
   "tagOwners": { "tag:librarium-sync": ["you@example.org"] },
   "grants": [
     { "src": ["you@example.org"],   "dst": ["*"],                  "ip": ["*"] },
     { "src": ["group:librarium"],   "dst": ["tag:librarium-sync"], "ip": ["tcp:8443", "tcp:22000"] }
   ]
   ```

3. **The server** runs Ubuntu 24.04 and you can SSH in as root.

## Setting it up

From this repository on your Mac:

```sh
scp -r deploy/sync root@<server>:/root/
ssh root@<server> 'bash /root/sync/setup.sh'
```

It ends by printing a **join code** (`librarium-join:…`). In Librarium, paste it in **Settings ▸
Sharing ▸ Join**. Running the script again is safe; it prints the same code.

## Inviting a colleague

1. Invite them to your Tailscale network (Users ▸ Invite users) and add their login email to
   `group:librarium` in the policy. They install Tailscale and sign in.
2. They install Librarium. You click **Invite a colleague** in Settings ▸ Sharing and send them
   the code it copies; they paste it in **Join**.

That's all: their Librarium connects to the sync server, makes Library ▸ Shared, and its own
Syncthing (built into Librarium) starts keeping it with the server, which lets their Mac in.

## Removing someone

Remove them from your Tailscale network (Users). They can no longer reach the server, so nothing
new reaches them; what they already have stays on their Mac. To tidy up, the Mac can also be
removed from the server's Syncthing (its settings page, below).

## What it sets up

| Piece | Detail |
|---|---|
| `librarium-sync` | `@automerge/automerge-repo-sync-server` (pinned), on `127.0.0.1:3031`, data in `/opt/librarium-sync/data`; published as `https://<name>:8443` by `tailscale serve` |
| `librarium-syncthing` | Syncthing (Debian `stable-v2` channel), home `/opt/stsync/librarium`, the Shared folder in `/opt/stsync/librarium-shared`; listens on the Tailscale address only; no discovery, relays, NAT traversal, usage reports or self-upgrades; removed files kept 30 days |
| `librarium-accept.timer` | every 5 s, lets each Mac that asks into the Shared folder (`accept_devices.py`) |
| Firewall | port 22000 on the Tailscale interface, if `ufw` is on |
| Backup | nightly copy of the boards' data to `/var/backups`, kept 14 days (copy it elsewhere too) |

Syncthing's own settings page is on the server only (`127.0.0.1:8384`). To look at it from your
Mac: `ssh -L 8385:127.0.0.1:8384 root@<server>`, then open http://localhost:8385 (its API key is
in `/opt/stsync/librarium/config.xml`; set a password under Actions ▸ Settings ▸ GUI the first
time).

## What this protects, and what it doesn't

- Nobody outside your Tailscale network can reach either service.
- Whoever runs the server can read what passes through it: boards and shared items aren't
  end-to-end encrypted. Fine for a group that trusts its host.
- Colleagues keep what they already received when they're removed.
- Anyone in `group:librarium` can join; the join code is not a secret, the policy is the lock.

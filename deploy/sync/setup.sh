#!/usr/bin/env bash
# Librarium's sync server, set up in one go on a Linux server (Ubuntu 24.04), put on your Tailscale
# network first if it isn't. Safe to run again. Librarium runs it for you (Settings ▸ Sharing ▸
# Set up your server…); by hand, as root from your Mac:
#
#   scp -r deploy/sync root@<server>:/root/ && ssh root@<server> 'bash /root/sync/setup.sh'
#
# It sets up, reachable only on your private network:
#   - the sync server for live boards (automerge-repo-sync-server), at https://<name>:8443;
#   - Syncthing for the Shared folder, at <name>:22000, with removed files kept 30 days, and a
#     job that lets in every Mac that connects (your Tailscale policy decides who can);
#   - a nightly backup of the boards' data.
# and prints the join code to paste in Librarium (Settings ▸ Sharing ▸ Join), and to send
# colleagues with Invite. See README.md.
set -euo pipefail

SYNC_VERSION="${SYNC_VERSION:-0.2.8}"
SYNC_PORT=3031
ST_HOME=/opt/stsync/librarium
ST_FOLDER=/opt/stsync/librarium-shared
ST_GUI=127.0.0.1:8384
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root."
# ---- Tailscale: installed and signed in if it isn't yet -------------------------------------
if ! command -v tailscale >/dev/null; then
  say "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
if ! tailscale ip -4 >/dev/null 2>&1; then
  say "Signing the server in to Tailscale"
  echo "Open the link below and approve the server (as the owner of tag:librarium-sync)."
  tailscale up --advertise-tags=tag:librarium-sync --hostname=librarium-sync
fi
TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
[ -n "$TS_IP" ] || die "this server isn't connected to your Tailscale network (tailscale up)."
TS_NAME="$(tailscale status --json | python3 -c 'import sys, json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
[ -n "$TS_NAME" ] || die "Tailscale gave no name for this server (turn on MagicDNS)."
echo "Tailscale: $TS_NAME ($TS_IP)"

export DEBIAN_FRONTEND=noninteractive
say "Packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg python3 >/dev/null
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! [ -f /etc/apt/sources.list.d/syncthing.list ] || ! grep -q stable-v2 /etc/apt/sources.list.d/syncthing.list; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL -o /etc/apt/keyrings/syncthing-archive-keyring.gpg https://syncthing.net/release-key.gpg
  echo "deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable-v2" > /etc/apt/sources.list.d/syncthing.list
  apt-get update -qq
fi
apt-get install -y -qq syncthing >/dev/null
echo "Node $(node -v), $(syncthing --version | cut -d' ' -f1-2)"

# ---- The sync server for live boards -------------------------------------------------------
say "Sync server (live boards)"
id librariumsync >/dev/null 2>&1 || useradd -r -m -d /opt/librarium-sync -s /usr/sbin/nologin librariumsync
sudo -u librariumsync bash -c "cd /opt/librarium-sync && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --no-fund --no-audit --silent @automerge/automerge-repo-sync-server@${SYNC_VERSION} && mkdir -p data"
cat >/etc/systemd/system/librarium-sync.service <<EOF
[Unit]
Description=Automerge sync server for Librarium
After=network.target

[Service]
User=librariumsync
WorkingDirectory=/opt/librarium-sync
Environment=PORT=${SYNC_PORT}
Environment=DATA_DIR=/opt/librarium-sync/data
ExecStart=/usr/bin/node node_modules/@automerge/automerge-repo-sync-server/src/index.js
Restart=always
RestartSec=3
ProtectSystem=strict
ReadWritePaths=/opt/librarium-sync
PrivateTmp=true
NoNewPrivileges=true
ProtectHome=true
PrivateDevices=true
MemoryMax=1G
TasksMax=256
# The server binds every address; only this machine may reach it (Tailscale passes it on).
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable librarium-sync >/dev/null 2>&1
systemctl restart librarium-sync
# Published on the private network only, over HTTPS (Tailscale's certificate).
tailscale serve --bg --https=8443 "${SYNC_PORT}" >/dev/null \
  || die "Tailscale couldn't publish the sync server over HTTPS. Turn on MagicDNS and HTTPS Certificates on Tailscale's DNS page, then run this again."

# ---- Syncthing for the Shared folder --------------------------------------------------------
say "Syncthing (Shared folder)"
id stsync >/dev/null 2>&1 || useradd -r -m -d /opt/stsync -s /usr/sbin/nologin stsync
# A Syncthing started by hand earlier (syncthing@stsync) gives way to this one.
systemctl disable --now syncthing@stsync >/dev/null 2>&1 || true
mkdir -p "$ST_FOLDER" && chown stsync:stsync "$ST_FOLDER"
if [ ! -f "$ST_HOME/config.xml" ]; then
  sudo -u stsync syncthing generate --home="$ST_HOME" --no-port-probing >/dev/null
  # Listens on the private network only; never announces itself, relays, reports or upgrades
  # (apt upgrades it).
  sudo -u stsync python3 - "$ST_HOME/config.xml" "$TS_IP" "$ST_GUI" <<'PY'
import re, sys
path, ip, gui = sys.argv[1:4]
x = open(path).read()
for a, b in [("<listenAddress>default</listenAddress>", f"<listenAddress>tcp://{ip}:22000</listenAddress>"),
             ("<globalAnnounceEnabled>true", "<globalAnnounceEnabled>false"),
             ("<localAnnounceEnabled>true", "<localAnnounceEnabled>false"),
             ("<relaysEnabled>true", "<relaysEnabled>false"),
             ("<natEnabled>true", "<natEnabled>false"),
             ("<startBrowser>true", "<startBrowser>false"),
             ("<urAccepted>0<", "<urAccepted>-1<"),
             ("<crashReportingEnabled>true", "<crashReportingEnabled>false")]:
    x = x.replace(a, b)
x = re.sub(r"<autoUpgradeIntervalH>\d+</autoUpgradeIntervalH>", "<autoUpgradeIntervalH>0</autoUpgradeIntervalH>", x)
x = re.sub(r"(<gui [^>]*>\s*<address>)[^<]*(</address>)", rf"\g<1>{gui}\g<2>", x, count=1)
open(path, "w").write(x)
PY
fi
cat >/etc/systemd/system/librarium-syncthing.service <<EOF
[Unit]
Description=Syncthing for Librarium's Shared folder
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=stsync
ExecStart=/usr/bin/syncthing serve --home=${ST_HOME} --no-browser --no-restart --no-upgrade
Restart=on-failure
RestartSec=5
ProtectSystem=strict
ReadWritePaths=/opt/stsync
PrivateTmp=true
NoNewPrivileges=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable librarium-syncthing >/dev/null 2>&1
systemctl restart librarium-syncthing
KEY="$(sed -n 's:.*<apikey>\(.*\)</apikey>.*:\1:p' "$ST_HOME/config.xml" | head -1)"
api() { curl -fsS -H "X-API-Key: $KEY" -H 'Content-Type: application/json' "$@"; }
for _ in $(seq 1 60); do api "http://$ST_GUI/rest/noauth/health" >/dev/null 2>&1 && break; sleep 1; done
api "http://$ST_GUI/rest/noauth/health" >/dev/null || die "Syncthing didn't start (journalctl -u librarium-syncthing)."
if ! api "http://$ST_GUI/rest/config/folders/librarium-shared" >/dev/null 2>&1; then
  api -X PUT "http://$ST_GUI/rest/config/folders/librarium-shared" -d "{\"id\":\"librarium-shared\",\"label\":\"Librarium Shared\",\"path\":\"$ST_FOLDER\",\"type\":\"sendreceive\",\"devices\":[],\"versioning\":{\"type\":\"trashcan\",\"params\":{\"cleanoutDays\":\"30\"}},\"fsWatcherEnabled\":true,\"fsWatcherDelayS\":2}" >/dev/null
fi
if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow in on tailscale0 to any port 22000 proto tcp >/dev/null
fi

# Lets in each Mac that connects (only your Tailscale network can reach this Syncthing).
install -D -m 755 "$HERE/accept_devices.py" /usr/local/lib/librarium/accept_devices.py
cat >/etc/systemd/system/librarium-accept.service <<EOF
[Unit]
Description=Let Macs on the Tailscale network into Librarium's Shared folder

[Service]
Type=oneshot
User=stsync
ExecStart=/usr/bin/python3 /usr/local/lib/librarium/accept_devices.py ${ST_HOME} http://${ST_GUI}
EOF
cat >/etc/systemd/system/librarium-accept.timer <<EOF
[Unit]
Description=Let Macs into Librarium's Shared folder, every few seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=5s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now librarium-accept.timer >/dev/null 2>&1

# ---- Nightly backup of the boards' data (the Shared folder is on every Mac already) -------------
cat >/etc/cron.daily/librarium-sync-backup <<'EOF'
#!/bin/sh
tar czf /var/backups/librarium-sync-$(date +%F).tgz -C /opt/librarium-sync data
find /var/backups -name 'librarium-sync-*.tgz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/librarium-sync-backup

# ---- The join code -------------------------------------------------------------------------
DEVICE="$(sudo -u stsync syncthing device-id --home="$ST_HOME" 2>/dev/null | tail -1)"
CODE="$(python3 - "$TS_NAME" "$DEVICE" <<'PY'
import base64, json, sys
name, device = sys.argv[1:3]
j = {"server": f"https://{name}:8443", "device": device, "address": f"tcp://{name}:22000"}
print("librarium-join:" + base64.urlsafe_b64encode(json.dumps(j, separators=(",", ":")).encode()).decode().rstrip("="))
PY
)"
say "Done"
systemctl --no-pager --quiet is-active librarium-sync librarium-syncthing librarium-accept.timer && echo "All three are running."
echo
echo "Join code (paste it in Librarium: Settings ▸ Sharing ▸ Join; colleagues get it from Invite):"
echo
echo "$CODE"
echo

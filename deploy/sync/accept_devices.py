#!/usr/bin/env python3
"""Adds every Mac that asks this Syncthing to connect, and shares the Librarium folder with it.

Only devices your Tailscale policy lets onto the private network can reach this Syncthing, so
asking is enough: the policy is the guest list. Run every few seconds (setup.sh installs a
systemd timer). Usage: accept_devices.py <syncthing home> [api url]
"""
import json
import re
import sys
import urllib.request

FOLDER = "librarium-shared"
home = sys.argv[1]
api = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8384"
key = re.search(r"<apikey>([^<]+)</apikey>", open(f"{home}/config.xml").read()).group(1)


def call(method, path, body=None):
    req = urllib.request.Request(api + path, method=method, headers={"X-API-Key": key, "Content-Type": "application/json"},
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as res:
        text = res.read().decode() or "null"
        return json.loads(text)


pending = call("GET", "/rest/cluster/pending/devices") or {}
for device, seen in pending.items():
    name = (seen or {}).get("name") or "Mac"
    call("PUT", f"/rest/config/devices/{device}", {"deviceID": device, "name": name, "addresses": ["dynamic"]})
    folder = call("GET", f"/rest/config/folders/{FOLDER}")
    if not any(d["deviceID"] == device for d in folder["devices"]):
        folder["devices"].append({"deviceID": device})
        call("PUT", f"/rest/config/folders/{FOLDER}", folder)
    print(f"accepted {name} ({device})")

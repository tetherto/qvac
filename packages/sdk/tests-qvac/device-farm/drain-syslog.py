"""Drain syslog entries from an Appium session and append to a log file.

Usage:
  python3 device-farm-drain-syslog.py <appium_url> <session_id> <output_file>

Example:
  python3 device-farm-drain-syslog.py http://127.0.0.1:4723/wd/hub abc123 /tmp/syslog.log
"""

import json
import sys
import urllib.request

if len(sys.argv) != 4:
    print(f"Usage: {sys.argv[0]} <appium_url> <session_id> <output_file>")
    sys.exit(1)

appium_url = sys.argv[1]
session_id = sys.argv[2]
output_file = sys.argv[3]

url = f"{appium_url}/session/{session_id}/log"
payload = json.dumps({"type": "syslog"}).encode("utf-8")

try:
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    entries = data.get("value", [])
    if entries:
        with open(output_file, "a") as f:
            for entry in entries:
                msg = entry.get("message", "")
                if msg:
                    f.write(msg + "\n")

    print(f"{len(entries)}")
except Exception:
    print("0")

#!/usr/bin/env python3
"""ScreenBeam ECB7250 management API (HTTP + CSRF)."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from typing import Any


ETH_SPEEDS = ["10Mbps", "100Mbps", "1Gbps", "Auto-Neg", "2.5Gbps", "NA"]


class ScreenBeamAdapter:
    def __init__(self, ip: str, user: str = "admin", password: str = "screenbeam") -> None:
        self.ip = ip
        self.user = user
        self.password = password
        self._jar: str | None = None
        self._csrf: str | None = None

    def _curl(self, *args: str, data: str | None = None) -> subprocess.CompletedProcess[str]:
        cmd = [
            "curl",
            "-sS",
            "-m",
            "8",
            "-u",
            f"{self.user}:{self.password}",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/x-www-form-urlencoded",
        ]
        if self._jar:
            cmd.extend(["-b", self._jar])
        if self._csrf:
            cmd.extend(["-H", f"X-CSRF-TOKEN: {self._csrf}"])
        cmd.extend(args)
        if data is not None:
            cmd.extend(["-d", data])
        return subprocess.run(cmd, capture_output=True, text=True, check=False)

    def login(self) -> bool:
        jar = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
        jar.close()
        self._jar = jar.name
        r = subprocess.run(
            [
                "curl",
                "-sS",
                "-m",
                "5",
                "-c",
                self._jar,
                "-u",
                f"{self.user}:{self.password}",
                f"http://{self.ip}/index.html",
                "-o",
                "/dev/null",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if r.returncode != 0:
            return False
        try:
            text = open(self._jar, encoding="utf-8", errors="replace").read()
            self._csrf = text.split("csrf_token\t")[-1].split("\n")[0].strip()
        except OSError:
            return False
        return bool(self._csrf)

    def ms_get(self, ep: str) -> dict[str, Any] | None:
        if not self._csrf and not self.login():
            return None
        url = ep if ep.startswith("http") else f"http://{self.ip}{ep}"
        if not url.endswith("/GET") and "/GET" not in ep and ep.startswith("/ms/"):
            pass
        body = '{"data":[""]}'
        r = self._curl(url, data=body)
        if not r.stdout.strip():
            return None
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            return None

    def ms_put(self, ep: str, value: int) -> bool:
        if not self._csrf and not self.login():
            return False
        url = f"http://{self.ip}{ep}" if ep.startswith("/") else f"http://{self.ip}/{ep}"
        r = self._curl(url, data=json.dumps({"data": [value]}))
        return r.returncode == 0

    def read_status(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ip": self.ip, "apiOk": False}
        if not self.login():
            out["error"] = "login failed"
            return out
        local = self.ms_get("/ms/0/0x15")
        eth = self.ms_get("/ms/1/0x307/GET")
        fw = self.ms_get("/ms/1/0x302/GET")
        nw = self.ms_get("/ms/0/0x1001/GET")
        nc = self.ms_get("/ms/0/0x1002/GET")
        if not local or not eth:
            out["error"] = "status read failed"
            return out
        lv = local.get("data") or []
        ev = eth.get("data") or []
        fwv = int((fw or {}).get("data", ["0"])[0], 16) if fw else 0
        link = int(ev[3], 16) if len(ev) > 3 else 0
        spd = int(ev[4], 16) if len(ev) > 4 else 0
        dpx = int(ev[5], 16) if len(ev) > 5 else 0
        moca_link = int(lv[5], 16) if len(lv) > 5 else 0
        moca_ver = int(lv[11], 16) if len(lv) > 11 else 0
        node_mask = int(lv[12], 16) if len(lv) > 12 else 0
        out.update(
            {
                "apiOk": True,
                "firmware": f"{fwv >> 24}.{(fwv >> 16) & 255}.{(fwv >> 8) & 255}.{fwv & 255}" if fwv else None,
                "mocaLink": "up" if moca_link else "down",
                "mocaVersion": f"{moca_ver >> 4}.{moca_ver & 0xF}",
                "nodeCount": bin(node_mask).count("1"),
                "ethLink": "up" if link else "down",
                "ethSpeed": ETH_SPEEDS[spd] if spd < len(ETH_SPEEDS) else str(spd),
                "ethDuplex": "full" if dpx else "half",
                "networkSearch": bool(int((nw or {}).get("data", ["0"])[0], 16)),
                "preferredNc": bool(int((nc or {}).get("data", ["0"])[0], 16)),
                "lofMhz": int((self.ms_get("/ms/0/0x1003/GET") or {}).get("data", ["0"])[0], 16),
            }
        )
        return out

    def apply_gaming_tune(self, preferred_nc: bool = False) -> dict[str, Any]:
        status = self.read_status()
        if not status.get("apiOk"):
            return {"ok": False, "ip": self.ip, "error": status.get("error", "unreachable")}

        changes: list[str] = []
        if status.get("networkSearch"):
            if self.ms_put("/ms/0/0x1001/PUT", 0):
                changes.append("networkSearch=off")
        if preferred_nc and not status.get("preferredNc"):
            if self.ms_put("/ms/0/0x1002/PUT", 1):
                changes.append("preferredNc=on")
        elif not preferred_nc and status.get("preferredNc"):
            if self.ms_put("/ms/0/0x1002/PUT", 0):
                changes.append("preferredNc=off")

        after = self.read_status()
        return {
            "ok": True,
            "ip": self.ip,
            "changed": changes,
            "alreadyTuned": not changes,
            "after": {
                "networkSearch": after.get("networkSearch"),
                "preferredNc": after.get("preferredNc"),
            },
        }


def ping_probe(host: str) -> dict[str, Any]:
    import statistics

    proc = subprocess.run(
        ["ping", "-c", "10", "-i", "0.2", "-W", "1", host],
        capture_output=True,
        text=True,
        check=False,
    )
    text = proc.stdout or ""
    ms = [float(x) for x in re.findall(r"time=(\d+(?:\.\d+)?)\s*ms", text)]
    neigh = subprocess.run(["ip", "neigh", "show", host], capture_output=True, text=True)
    mac = ""
    state = "unknown"
    for line in (neigh.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == host:
            mac = parts[4] if parts[3] == "lladdr" else (parts[5] if len(parts) > 5 else "")
            state = parts[-1] if parts else "unknown"
    jitter = statistics.pstdev(ms) if len(ms) > 1 else 0
    online = len(ms) >= 3
    return {
        "online": online,
        "mac": mac or None,
        "neighState": state,
        "samples": len(ms),
        "minMs": round(min(ms), 2) if ms else None,
        "avgMs": round(statistics.mean(ms), 2) if ms else None,
        "maxMs": round(max(ms), 2) if ms else None,
        "jitterMs": round(jitter, 2) if ms else None,
        "packetLoss": round(100 - (len(ms) / 10 * 100), 1) if ms else 100,
    }


def probe_adapter(host: str, label: str, role: str, user: str, password: str) -> dict[str, Any]:
    ping = ping_probe(host)
    http = subprocess.run(
        ["curl", "-sS", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", f"http://{host}/"],
        capture_output=True,
        text=True,
        check=False,
    )
    http_code = (http.stdout or "").strip()
    row: dict[str, Any] = {
        "role": role,
        "label": label,
        "ip": host,
        **ping,
        "httpStatus": http_code or None,
        "mgmtUi": http_code in ("200", "401", "501"),
    }
    if password:
        api = ScreenBeamAdapter(host, user, password).read_status()
        if api.get("apiOk"):
            row.update(
                {
                    "firmware": api.get("firmware"),
                    "mocaLink": api.get("mocaLink"),
                    "mocaVersion": api.get("mocaVersion"),
                    "nodeCount": api.get("nodeCount"),
                    "ethSpeed": api.get("ethSpeed"),
                    "ethDuplex": api.get("ethDuplex"),
                    "networkSearch": api.get("networkSearch"),
                    "preferredNc": api.get("preferredNc"),
                    "lofMhz": api.get("lofMhz"),
                }
            )
    return row


def cmd_track() -> None:
    import datetime

    xbox = os.environ["XBOX_IP"]
    ip1 = os.environ.get("MOCA_DEVICE_1_IP", "192.168.167.13")
    ip2 = os.environ.get("MOCA_DEVICE_2_IP", "192.168.167.19")
    l1 = os.environ.get("MOCA_DEVICE_1_LABEL", "MoCA .13")
    l2 = os.environ.get("MOCA_DEVICE_2_LABEL", "MoCA .19")
    user = os.environ.get("MOCA_ADMIN_USER", "admin")
    password = os.environ.get("MOCA_ADMIN_PASSWORD", "")

    adapters = [
        probe_adapter(ip1, l1, "adapter-1", user, password),
        probe_adapter(ip2, l2, "adapter-2", user, password),
    ]
    xbox_probe = probe_adapter(xbox, "Xbox SQUATX", "xbox", user, "")
    xbox_probe["role"] = "xbox"
    path_ok = all(a["online"] for a in adapters) and xbox_probe["online"]
    hop_est = None
    if adapters[0].get("avgMs") is not None and xbox_probe.get("avgMs") is not None:
        hop_est = round(max(0, xbox_probe["avgMs"] - min(a.get("avgMs") or 999 for a in adapters)), 2)

    print(
        json.dumps(
            {
                "ok": True,
                "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "vendor": "ScreenBeam ECB7250",
                "adapters": adapters,
                "xboxPath": xbox_probe,
                "path": {
                    "ok": path_ok,
                    "estimatedMocaHopMs": hop_est,
                    "avgMs": xbox_probe.get("avgMs"),
                    "jitterMs": xbox_probe.get("jitterMs"),
                },
            },
            indent=2,
        )
    )


def cmd_adapter_tune() -> None:
    ip1 = os.environ.get("MOCA_DEVICE_1_IP", "192.168.167.13")
    ip2 = os.environ.get("MOCA_DEVICE_2_IP", "192.168.167.19")
    user = os.environ.get("MOCA_ADMIN_USER", "admin")
    password = os.environ.get("MOCA_ADMIN_PASSWORD", "")
    if not password:
        print(json.dumps({"ok": False, "error": "MOCA_ADMIN_PASSWORD not set"}, indent=2))
        raise SystemExit(1)

    results = [
        ScreenBeamAdapter(ip1, user, password).apply_gaming_tune(preferred_nc=True),
        ScreenBeamAdapter(ip2, user, password).apply_gaming_tune(preferred_nc=False),
    ]
    print(json.dumps({"ok": all(r.get("ok") for r in results), "results": results}, indent=2))


def cmd_adapter_status() -> None:
    ip1 = os.environ.get("MOCA_DEVICE_1_IP", "192.168.167.13")
    ip2 = os.environ.get("MOCA_DEVICE_2_IP", "192.168.167.19")
    user = os.environ.get("MOCA_ADMIN_USER", "admin")
    password = os.environ.get("MOCA_ADMIN_PASSWORD", "")
    if not password:
        print(json.dumps({"ok": False, "error": "MOCA_ADMIN_PASSWORD not set"}, indent=2))
        raise SystemExit(1)
    rows = [
        ScreenBeamAdapter(ip1, user, password).read_status(),
        ScreenBeamAdapter(ip2, user, password).read_status(),
    ]
    print(json.dumps({"ok": all(r.get("apiOk") for r in rows), "adapters": rows}, indent=2))


if __name__ == "__main__":
    action = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    if action == "track":
        cmd_track()
    elif action == "adapter-tune":
        cmd_adapter_tune()
    elif action == "adapter-status":
        cmd_adapter_status()
    else:
        print(json.dumps({"ok": False, "error": f"unknown action: {action}"}))
        raise SystemExit(2)

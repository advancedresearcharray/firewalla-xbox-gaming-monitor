# Firewalla Xbox Gaming Monitor

Live Xbox traffic dashboard powered by **Firewalla Gold/Purple**. Monitors connections during gaming, classifies server roles (matchmaking, CDN, telemetry), applies per-destination QoS, probes internet paths (IPv4 vs IPv6), and **blocks slow routes at the firewall** so the console uses the fastest path.

> **Disclaimer:** This is an independent community project. It is **not affiliated with, endorsed by, or supported by Firewalla Inc.** It modifies network behavior on your Firewalla device using scripts, QoS rules, and internal APIs. **Use at your own risk.** You are solely responsible for any impact to your network, device stability, security, or warranty. Firewalla may change internal behavior at any time, which could break this software without notice.

## Features

- **Live dashboard** — bandwidth, connections, latency, server roles
- **Server classification** — PlayFab, Xbox Live, CDN, telemetry, etc.
- **Traffic policies** — Balanced / Competitive / Download (DSCP via CAKE)
- **Route efficiency** — ping all path candidates, rank Azure datacenter regions
- **Path enforcement** — iptables DROP on slow alternate IPs for Xbox traffic
- **Dual-stack** — IPv4 + IPv6 (Warzone and modern titles use IPv6 heavily)
- **Session advisor** — local heuristics, learning, lobby prediction, bandwidth spike detection

## Architecture

```
┌─────────────┐     SSH      ┌──────────────────┐     FORWARD     ┌──────┐
│  Dashboard  │─────────────▶│  Firewalla Gold  │◀───────────────▶│ Xbox │
│  (Node.js)  │  snapshot.sh │  gaming-tools/   │   QoS + blocks  └──────┘
└─────────────┘              └──────────────────┘
```

| Component | Runs on | Purpose |
|-----------|---------|---------|
| `remote/gaming-snapshot.sh` | Firewalla | JSON collector (conntrack, Redis, ping, tcpdump) |
| `remote/gaming-role-qos.sh` | Firewalla | Per-destination DSCP marking |
| `remote/gaming-route-probe.sh` | Firewalla | Path probing + datacenter ranking |
| `remote/gaming-route-enforce.sh` | Firewalla | Block slow paths (ipset + iptables) |
| `server.mjs` + `public/` | LAN host / LXC / Docker | Web UI + API |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

### Address placeholders

Examples in this repo use fictional addresses — replace with your LAN values in `gaming.conf` and dashboard env:

| Placeholder | Role |
|-------------|------|
| `A.A.A.A` | Firewalla LAN IP |
| `B.B.B.B` | Xbox IPv4 |
| `C.C.C.C` | Dashboard host |
| `aa:bb:cc:dd:ee:ff` | Xbox MAC (example) |

WAN latency probes use the public hostname `one.one.one.one` (configurable via `WAN_PROBE_HOST` / `wanProbeHost`).

## Quick start

### 1. Install scripts on Firewalla

Enable **SSH** on Firewalla (App → Settings → Advanced → SSH).

```bash
git clone https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor.git
cd firewalla-xbox-gaming-monitor

# Copy scripts to Firewalla
scp -r remote/ data/route-probes.json deploy/gaming.conf.example \
  pi@A.A.A.A:/tmp/gaming-install/

ssh pi@A.A.A.A
  cd /tmp/gaming-install
  # Edit gaming.conf.example → set XBOX_IP, XBOX_MAC, LAN_IF
  bash ../scripts/install-on-firewalla.sh   # or run from repo on Firewalla
  nano /home/pi/gaming-tools/gaming.conf
  bash /home/pi/gaming-tools/gaming-snapshot.sh | head -c 500   # smoke test
```

### 2. Install dashboard (any Linux host on LAN)

```bash
sudo FIREWALLA_API_URL=http://A.A.A.A:9378 FIREWALLA_API_TOKEN=<your-token> XBOX_IP=B.B.B.B ./scripts/install-dashboard.sh
# Open http://C.C.C.C:9377/
```

**Docker alternative:**

```bash
FIREWALLA_API_URL=http://A.A.A.A:9378 FIREWALLA_API_TOKEN=<your-token> XBOX_IP=B.B.B.B docker compose up -d
```

Full guide: [docs/INSTALL.md](docs/INSTALL.md)

## Requirements

| Item | Requirement |
|------|-------------|
| Firewalla | **Gold or Purple** recommended (SSH, SQM, ifb, Redis, conntrack) |
| SSH | Enabled; `pi` user (default Firewalla SSH) |
| Dashboard host | Node.js 20+ or Docker (e.g. `C.C.C.C`) |
| Xbox | Static DHCP reservation recommended — set `B.B.B.B` + MAC in `gaming.conf` |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/snapshot` | GET | Latest enriched snapshot |
| `/api/stream` | GET | SSE live stream |
| `/api/traffic-policy` | POST | `{ "profile": "balanced\|competitive\|download" }` |
| `/api/competitive-policy` | GET/POST | Bandwidth mode (dynamic/static Mbps), Xbox buffers (normal/large/max), Xbox-only DNS |
| `/api/route-probe` | POST | Force path probe |
| `/api/route-policy` | GET/POST | Path enforcement on/off |
| `/api/ai-insights` | GET/POST | Local session analysis (heuristics + learning) |
| `/api/health` | GET | Service health |

## For Firewalla team

We built this as a community tool and would love Firewalla to review it for accuracy, safety, and possible product integration.

**Start here:** [docs/FIREWALLA-REVIEW.md](docs/FIREWALLA-REVIEW.md)

**Contact options:**

1. **GitHub Issue** on [firewalla/firewalla](https://github.com/firewalla/firewalla) — official open-source repo (AGPL-3.0); best for engineering visibility
2. Email **help@firewalla.com** with subject `Community: Xbox Gaming Monitor review`
3. Forum post: [forum.firewalla.com](https://forum.firewalla.com) (Tips & Tricks / Feature Requests)
4. GitHub Issues on [this repo](https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor) for bugs and feedback

This project is **separate from** [firewalla/firewalla](https://github.com/firewalla/firewalla) (the core OS at `/home/pi/firewalla`). Our scripts install under `/home/pi/gaming-tools/` and do not patch core. Long-term, a native integration could live in `extension/` or similar — see [docs/FIREWALLA-REVIEW.md](docs/FIREWALLA-REVIEW.md).

## Safety notes

- Route enforcement adds `iptables`/`ipset` DROP rules in `FORWARD` for **Xbox source IPs only**
- QoS uses `mangle` POSTROUTING DSCP marks; works with Firewalla CAKE `diffserv3`
- **Competitive bandwidth:** `dynamic` (Firewalla allocates) or `static` Mbps caps on Xbox only via ingress policing
- **Xbox buffers:** `normal` / `large` / `max` tc police burst (Xbox-only); large/max also widen NIC rings on eth0–eth2
- **DNS:** off by default; when enabled, redirects DNS queries **only from XBOX_IP/MAC** — does not change DHCP or global Firewalla DNS (fixes laptop/other-device timeout issues)
- Scripts are read-only on Firewalla except for explicit QoS/enforcement sync commands
- No Firewalla OS or app modification required — files live in `/home/pi/gaming-tools/`

## License

MIT — see [LICENSE](LICENSE)

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
┌─────────────┐   HTTP :9378    ┌──────────────────────┐   on-box scripts   ┌──────┐
│  Dashboard  │──────────────▶│  array-firewalla-api │───────────────────▶│ Xbox │
│  (Node.js)  │  Bearer token │  on Firewalla Gold   │  QoS + snapshots   └──────┘
└─────────────┘               │  gaming-tools/       │
                              └──────────────────────┘
                                      ▲
                                      │ localhost netbot bridge
                               official Firewalla netbot API
```

The dashboard **never** opens SSH to Firewalla. All remote operations go through [array-firewalla-api](https://github.com/advancedresearcharray/array-firewalla-api) on the LAN (`POST /api/v1/run`, `/api/v1/netbot`, `/api/v1/tools/update`).

| Component | Runs on | Purpose |
|-----------|---------|---------|
| `array-firewalla-api` | Firewalla | LAN HTTP API + netbot bridge |
| `remote/gaming-snapshot.sh` | Firewalla | JSON collector (netbot flows/hosts, conntrack, Redis) |
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

### 1. Bootstrap LAN API on Firewalla (one-time)

Install [array-firewalla-api](https://github.com/advancedresearcharray/array-firewalla-api) on the box. After bootstrap, **SSH is not required** for the dashboard or deploy scripts.

See `array-firewalla-api` → `scripts/bootstrap-firewalla-api-once.sh` (one-time only), then verify:

```bash
curl -sS http://A.A.A.A:9378/api/health
```

### 2. Push gaming-tools over LAN API

From a host on your LAN (with `FIREWALLA_API_TOKEN` set):

```bash
FIREWALLA_API_URL=http://A.A.A.A:9378 ./scripts/push-firewalla-tools-api.sh
```

Edit `/home/pi/gaming-tools/gaming.conf` on Firewalla (App console or one-time shell access) — set `XBOX_IP`, `XBOX_MAC`, `LAN_IF`.

Smoke test via API:

```bash
curl -sS -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "http://A.A.A.A:9378/api/v1/run" \
  -d '{"script":"gaming-snapshot.sh","args":["B.B.B.B"],"sudo":false}' | head -c 500
```

### 3. Install dashboard (any Linux host on LAN)

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
| Firewalla | **Gold or Purple** (SQM, ifb, Redis, conntrack) |
| LAN API | [array-firewalla-api](https://github.com/advancedresearcharray/array-firewalla-api) on `:9378`, LAN CIDR + bearer token |
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

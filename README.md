# Firewalla Xbox Gaming Monitor

Live Xbox traffic dashboard powered by **Firewalla Gold/Purple**. Monitors connections during gaming, classifies server roles (matchmaking, CDN, telemetry), applies per-destination QoS, probes internet paths (IPv4 vs IPv6), and **blocks slow routes at the firewall** so the console uses the fastest path.

## Features

- **Live dashboard** — bandwidth, connections, latency, server roles
- **Server classification** — PlayFab, Xbox Live, CDN, telemetry, etc.
- **Traffic policies** — Balanced / Competitive / Download (DSCP via CAKE)
- **Route efficiency** — ping all path candidates, rank Azure datacenter regions
- **Path enforcement** — iptables DROP on slow alternate IPs for Xbox traffic
- **Dual-stack** — IPv4 + IPv6 (Warzone and modern titles use IPv6 heavily)

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

## Quick start

### 1. Install scripts on Firewalla

Enable **SSH** on Firewalla (App → Settings → Advanced → SSH).

```bash
git clone https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor.git
cd firewalla-xbox-gaming-monitor

# Copy scripts to Firewalla
scp -r remote/ data/route-probes.json deploy/gaming.conf.example \
  pi@192.168.1.1:/tmp/gaming-install/

ssh pi@192.168.1.1
  cd /tmp/gaming-install
  # Edit gaming.conf.example → set XBOX_IP, XBOX_MAC, LAN_IF
  bash ../scripts/install-on-firewalla.sh   # or run from repo on Firewalla
  nano /home/pi/gaming-tools/gaming.conf
  bash /home/pi/gaming-tools/gaming-snapshot.sh | head -c 500   # smoke test
```

### 2. Install dashboard (any Linux host on LAN)

```bash
sudo FIREWALLA_HOST=192.168.1.1 XBOX_IP=192.168.1.100 ./scripts/install-dashboard.sh
# Open http://<host-ip>:9377/
```

**Docker alternative:**

```bash
mkdir -p deploy/ssh
cp ~/.ssh/firewalla-gaming-monitor deploy/ssh/
cp ~/.ssh/firewalla-gaming-monitor.pub deploy/ssh/
# Add pubkey to Firewalla pi@authorized_keys first
FIREWALLA_HOST=192.168.1.1 XBOX_IP=192.168.1.100 docker compose up -d
```

Full guide: [docs/INSTALL.md](docs/INSTALL.md)

## Requirements

| Item | Requirement |
|------|-------------|
| Firewalla | **Gold or Purple** recommended (SSH, SQM, ifb, Redis, conntrack) |
| SSH | Enabled; `pi` user (default Firewalla SSH) |
| Dashboard host | Node.js 20+ or Docker |
| Xbox | Static DHCP reservation recommended (IP + MAC in `gaming.conf`) |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/snapshot` | GET | Latest enriched snapshot |
| `/api/stream` | GET | SSE live stream |
| `/api/traffic-policy` | POST | `{ "profile": "balanced\|competitive\|download" }` |
| `/api/route-probe` | POST | Force path probe |
| `/api/route-policy` | GET/POST | Path enforcement on/off |
| `/api/health` | GET | Service health |

## For Firewalla team

We built this as a community tool and would love Firewalla to review it for accuracy, safety, and possible product integration.

**Start here:** [docs/FIREWALLA-REVIEW.md](docs/FIREWALLA-REVIEW.md)

**Contact options:**

1. Email **help@firewalla.com** with subject `Community: Xbox Gaming Monitor review`
2. Forum post: [forum.firewalla.com](https://forum.firewalla.com) (Tips & Tricks / Feature Requests)
3. GitHub Issues on this repo for bugs and feedback

## Safety notes

- Route enforcement adds `iptables`/`ipset` DROP rules in `FORWARD` for **Xbox source IPs only**
- QoS uses `mangle` POSTROUTING DSCP marks; works with Firewalla CAKE `diffserv3`
- Scripts are read-only on Firewalla except for explicit QoS/enforcement sync commands
- No Firewalla OS or app modification required — files live in `/home/pi/gaming-tools/`

## License

MIT — see [LICENSE](LICENSE)

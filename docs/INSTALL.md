# Installation guide

## Overview

Three parts:

1. **array-firewalla-api** on Firewalla — LAN HTTP API (one-time bootstrap)
2. **Gaming scripts** (`remote/`) — pushed via API, not SSH
3. **Dashboard** (`server.mjs`) — polls Firewalla over HTTP, serves web UI

The dashboard **does not use SSH** to reach Firewalla.

---

## Part A — array-firewalla-api (Firewalla Gold / Purple)

### Prerequisites

- Firewalla Gold or Purple on recent firmware (6.x+)
- Xbox on LAN with known IPv4 (and ideally MAC for IPv6 discovery)
- Gaming Mode / QoS enabled on Firewalla (uses existing SQM/ifb)

### One-time bootstrap

Install [array-firewalla-api](https://github.com/advancedresearcharray/array-firewalla-api) on the box. Follow that repo's bootstrap script once, then set `BIND_ADDRESS`, LAN CIDR allowlist, and bearer token in `/etc/default/firewalla-api`.

Verify:

```bash
curl -sS http://A.A.A.A:9378/api/health
# netbotBridge.ok should be true
```

### Push gaming-tools (no SSH)

From any LAN host with the API token:

```bash
export FIREWALLA_API_URL=http://A.A.A.A:9378
export FIREWALLA_API_TOKEN=<your-token>
./scripts/push-firewalla-tools-api.sh
```

Or use the fleet deploy script from your ops host:

```bash
./scripts/deploy-xbox-traffic-monitor.sh
```

### Configure `gaming.conf`

On Firewalla, edit `/home/pi/gaming-tools/gaming.conf`:

```bash
XBOX_IP="B.B.B.B"
XBOX_MAC="aa:bb:cc:dd:ee:ff"
XBOX_NAME="Xbox"
LAN_IF="br2"
UPLOAD_IF="ifb0"
DOWNLOAD_IF="ifb1"
```

Find LAN bridge: `ip link | grep br` (on-box console if needed).

### Verify via LAN API

```bash
# Snapshot JSON
curl -sS -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-snapshot.sh","args":["B.B.B.B"],"sudo":false}' | python3 -m json.tool | head -40

# QoS status
curl -sS -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-role-qos.sh","args":["status"],"sudo":true}'
```

**Offline fallback:** If API is not yet available, run `scripts/install-on-firewalla.sh` directly on the box (copy files via USB/console). Normal operation still uses HTTP only.

---

## Part B — Dashboard host

Any Linux machine on the same LAN (Proxmox LXC, Raspberry Pi, NAS, VM).

### Option 1: install script (systemd)

```bash
sudo FIREWALLA_API_URL=http://A.A.A.A:9378 \
     FIREWALLA_API_TOKEN=<your-token> \
     XBOX_IP=B.B.B.B \
     PORT=9377 \
     ./scripts/install-dashboard.sh
```

No SSH keys. The script verifies the LAN API before starting.

### Option 2: Docker Compose

```bash
FIREWALLA_API_URL=http://A.A.A.A:9378 \
FIREWALLA_API_TOKEN=<your-token> \
XBOX_IP=B.B.B.B \
docker compose up -d
```

### Option 3: manual

```bash
cp -r . /opt/xbox-traffic-monitor
cp deploy/env.example /etc/default/xbox-traffic-monitor   # edit values
cp deploy/xbox-traffic-monitor.service /etc/systemd/system/
systemctl enable --now xbox-traffic-monitor
```

Required env: `FIREWALLA_API_URL`, `FIREWALLA_API_TOKEN`, `XBOX_IP`.

---

## Using the dashboard

1. Open `http://C.C.C.C:9377/`
2. Launch a game on Xbox
3. Watch **Connecting to** for live servers
4. Click **Probe routes now** for datacenter ranking
5. **Enforce best paths** (default ON) pushes firewall blocks via API
6. **Competitive profile** — dynamic bandwidth (official netbot policies) or static Mbps caps
7. **Xbox-only DNS** — leave off unless you need custom resolvers for the console

---

## Uninstall

**Firewalla (via API):**

```bash
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-role-qos.sh","args":["off"],"sudo":true}'
# repeat for gaming-bandwidth-qos.sh, gaming-dns-policy.sh, gaming-route-enforce.sh off
```

**Dashboard:**

```bash
sudo systemctl disable --now xbox-traffic-monitor
sudo rm /etc/systemd/system/xbox-traffic-monitor.service /etc/default/xbox-traffic-monitor
sudo rm -rf /opt/xbox-traffic-monitor
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Empty connections | Ensure Xbox is online; check IPv6 — many games use IPv6 only |
| API 401 / connection refused | Verify `FIREWALLA_API_TOKEN`; check `curl …/api/health` and `netbotBridge.ok` |
| QoS not applied | Run role-qos with `"sudo":true` via `/api/v1/run`; check dashboard profile |
| Laptop can't reach some sites | Run `gaming-dns-policy.sh off` via API — DNS override is Xbox-only |
| Route blocks not active | Probe routes from dashboard first; check enforce status via API |
| Wrong LAN bridge | Set `LAN_IF` in gaming.conf |

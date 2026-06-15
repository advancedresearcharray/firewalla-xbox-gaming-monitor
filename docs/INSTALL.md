# Installation guide

## Overview

Two parts:

1. **Firewalla scripts** (`remote/`) — data collection, QoS, route probe, route enforcement
2. **Dashboard** (`server.mjs`) — polls Firewalla over SSH, serves web UI

---

## Part A — Firewalla (Gold / Purple)

### Prerequisites

- Firewalla Gold or Purple on recent firmware (6.x+)
- SSH enabled: Firewalla App → **Settings → Advanced → SSH → ON**
- Xbox on LAN with known IPv4 (and ideally MAC for IPv6 discovery)
- Gaming Mode / QoS enabled on Firewalla (uses existing SQM/ifb)

### Install

```bash
git clone https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor.git
cd firewalla-xbox-gaming-monitor
chmod +x scripts/*.sh remote/*.sh

# From your PC — push to Firewalla
scp -r remote data/route-probes.json scripts/install-on-firewalla.sh \
  pi@A.A.A.A:/home/pi/gaming-install/

ssh pi@A.A.A.A
cd /home/pi/gaming-install
bash install-on-firewalla.sh
nano /home/pi/gaming-tools/gaming.conf
```

### Configure `gaming.conf`

```bash
XBOX_IP="B.B.B.B"                  # Xbox IPv4
XBOX_MAC="aa:bb:cc:dd:ee:ff"       # For IPv6 neighbor lookup
XBOX_NAME="Xbox"
LAN_IF="br2"                    # br0 or br2 depending on network setup
UPLOAD_IF="ifb0"
DOWNLOAD_IF="ifb1"
```

Find LAN bridge: `ip link | grep br`

### Verify on Firewalla

```bash
# Snapshot JSON (should show xbox, connections, destinations)
bash /home/pi/gaming-tools/gaming-snapshot.sh | python3 -m json.tool | head -40

# Route probe (takes ~30–60s)
bash /home/pi/gaming-tools/gaming-route-probe.sh | python3 -m json.tool | head -30

# QoS status (requires sudo)
sudo /home/pi/gaming-tools/gaming-role-qos.sh status

# Route enforcement (requires sudo)
sudo /home/pi/gaming-tools/gaming-route-enforce.sh status
```

---

## Part B — Dashboard host

Any Linux machine on the same LAN (Proxmox LXC, Raspberry Pi, NAS, VM).

### Option 1: install script (systemd)

```bash
sudo FIREWALLA_HOST=A.A.A.A \
     XBOX_IP=B.B.B.B \
     PORT=9377 \
     ./scripts/install-dashboard.sh
```

The script generates an SSH key — add the printed public key to Firewalla:

```bash
ssh pi@A.A.A.A
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAA... xbox-gaming-monitor' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

### Option 2: Docker Compose

```bash
# Generate key and authorize on Firewalla first
ssh-keygen -t ed25519 -N "" -f deploy/ssh/firewalla-gaming-monitor
cat deploy/ssh/firewalla-gaming-monitor.pub   # add to Firewalla

FIREWALLA_HOST=A.A.A.A XBOX_IP=B.B.B.B docker compose up -d
```

### Option 3: manual

```bash
cp -r . /opt/xbox-traffic-monitor
cp deploy/env.example /etc/default/xbox-traffic-monitor   # edit values
cp deploy/xbox-traffic-monitor.service /etc/systemd/system/
systemctl enable --now xbox-traffic-monitor
```

---

## Using the dashboard

1. Open `http://C.C.C.C:9377/`
2. Launch a game on Xbox
3. Watch **Connecting to** for live servers
4. Click **Probe routes now** for datacenter ranking
5. **Enforce best paths** (default ON) pushes firewall blocks to Firewalla
6. **Competitive profile** — choose **Dynamic** bandwidth (Firewalla allocates) or **Static** Mbps caps (Xbox only)
7. **Xbox-only DNS** — leave off unless you need custom resolvers for the console; laptops/phones keep normal DNS

---

## Uninstall

**Firewalla:**

```bash
sudo /home/pi/gaming-tools/gaming-role-qos.sh off
sudo /home/pi/gaming-tools/gaming-bandwidth-qos.sh off
sudo /home/pi/gaming-tools/gaming-dns-policy.sh off
sudo /home/pi/gaming-tools/gaming-route-enforce.sh off
rm -rf /home/pi/gaming-tools/gaming-*.sh /home/pi/gaming-tools/xbox-scope.sh /home/pi/gaming-tools/route-probes.json
# Keep or remove gaming.conf
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
| SSH fails from dashboard | Verify key in `pi@authorized_keys`; test `ssh -i key pi@A.A.A.A bash gaming-snapshot.sh B.B.B.B` |
| QoS not applied | Run with `sudo`; check `sudo gaming-role-qos.sh status` |
| Laptop can't reach some sites after changes | Run `sudo gaming-dns-policy.sh off` — DNS override is Xbox-only; if issues persist, switch profile to **Balanced** |
| Other devices affected | Verify `XBOX_IP` in gaming.conf is the console only (not a shared gateway IP) |
| Route blocks not active | `sudo gaming-route-enforce.sh status`; run probe first via dashboard |
| Wrong LAN bridge | Set `LAN_IF` in gaming.conf to match `ip link` |

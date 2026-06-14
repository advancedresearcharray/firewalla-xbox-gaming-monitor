# For Firewalla team — review & test guide

Thank you for reviewing this community project. This document is written for Firewalla engineers and QA to evaluate the tool safely on Gold/Purple hardware.

## What this is

An **optional** Xbox gaming network monitor that:

- Reads connection data Firewalla already collects (Redis `conn:*`, conntrack, SQM)
- Classifies gaming server hostnames (PlayFab, CDN, telemetry, etc.)
- Applies optional per-destination DSCP marks via `iptables mangle`
- Probes IPv4/IPv6 paths and optionally **blocks slow alternate routes** for Xbox traffic only

**It does not modify Firewalla core**, firmware, or the mobile app. All scripts install under `/home/pi/gaming-tools/`.

## Recommended test setup

| Item | Suggestion |
|------|------------|
| Hardware | Firewalla Gold (SSH + dual ifb SQM) |
| Firmware | Current stable (6.x release branch) |
| SSH | Enable in app → Settings → Advanced → SSH |
| Xbox | One console on LAN, DHCP reservation |
| Dashboard | Separate Linux host OR Docker on LAN (see INSTALL.md) |

## 15-minute test plan

### Step 1 — Install Firewalla scripts (2 min)

```bash
git clone https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor.git
cd firewalla-xbox-gaming-monitor
scp -r remote data/route-probes.json scripts/install-on-firewalla.sh pi@<firewalla>:/tmp/gaming/
ssh pi@<firewalla> 'bash /tmp/gaming/install-on-firewalla.sh'
```

Edit `/home/pi/gaming-tools/gaming.conf` with test Xbox IP/MAC.

### Step 2 — Smoke test collector (1 min)

```bash
ssh pi@<firewalla> 'bash /home/pi/gaming-tools/gaming-snapshot.sh' | python3 -m json.tool | head -60
```

**Expected:** JSON with `xbox`, `connections`, `destinations`, `wan`, `sqm` keys.

### Step 3 — Install dashboard (5 min)

On a LAN Linux host:

```bash
sudo FIREWALLA_HOST=<firewalla-ip> XBOX_IP=<xbox-ip> ./scripts/install-dashboard.sh
```

Add generated SSH public key to `pi@<firewalla>:~/.ssh/authorized_keys`.

Open `http://<dashboard>:9377/` — verify live metrics with Xbox online.

### Step 4 — Gaming session test (5 min)

1. Launch an online game (e.g. CoD, Fortnite, Halo)
2. Confirm **Connecting to** table populates with hostnames
3. Click **Probe routes now** — datacenter ranking should appear
4. Verify **Enforce best paths** shows blocked slow region IPs

### Step 5 — Verify firewall rules (2 min)

```bash
ssh pi@<firewalla> 'sudo /home/pi/gaming-tools/gaming-route-enforce.sh status'
ssh pi@<firewalla> 'sudo iptables -L XBOX_ROUTE_ENFORCE -n -v'
ssh pi@<firewalla> 'sudo ipset list xbox_route_block'
```

**Expected:** `enabled=active`, DROP chain, ipset entries for slow region probe IPs.

### Step 6 — Clean uninstall

```bash
ssh pi@<firewalla> 'sudo /home/pi/gaming-tools/gaming-route-enforce.sh off'
ssh pi@<firewalla> 'sudo /home/pi/gaming-tools/gaming-role-qos.sh off'
```

Confirm `iptables -L XBOX_ROUTE_ENFORCE` and ipsets are gone.

---

## Security review checklist

- [ ] Scripts run as `pi` user; only QoS/enforcement call `sudo` for iptables/ipset
- [ ] No credentials stored in repo
- [ ] SSH is key-based from dashboard → Firewalla (standard admin access)
- [ ] iptables rules scoped to Xbox source IP(s) only
- [ ] ipset entries are specific /32 (or /128) host routes, not broad CIDR blocks
- [ ] No writes to `/home/pi/firewalla` or system directories
- [ ] Uninstall removes all chains, jumps, and ipsets

## Questions for Firewalla

1. **API access** — Can third-party tools use a supported API instead of SSH + redis-cli for connection data?
2. **App platform** — Is there a path to ship this as an official Firewalla App container on Gold?
3. **Policy integration** — Should route enforcement go through Firerouter/policy engine instead of raw iptables?
4. **IPv6** — Any recommended approach for dual-stack gaming on Purple/Gold?
5. **Redis schema** — Is `conn:*` key format stable across firmware versions?

## How to share feedback

| Channel | Action |
|---------|--------|
| **GitHub Issues** | Bug reports, feature requests on this repo |
| **Email** | help@firewalla.com — subject: `Community: Xbox Gaming Monitor review` |
| **Forum** | Post on forum.firewalla.com with link to repo (Tips & Tricks) |
| **Pull requests** | Welcome for Firewalla-specific improvements |

## Suggested email template

```
To: help@firewalla.com
Subject: Community: Xbox Gaming Monitor — review request

Hi Firewalla team,

We've built an open-source Xbox gaming traffic monitor that uses Firewalla Gold
for connection visibility, QoS, and route optimization:

  https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor

It installs optional scripts under /home/pi/gaming-tools/ and does not modify
Firewalla core. See docs/FIREWALLA-REVIEW.md for a 15-minute test plan.

We'd appreciate your review for safety/compatibility and any guidance on
official App integration.

Thanks,
[Your name]
```

## Distribution paths (current landscape)

| Path | Status | Notes |
|------|--------|-------|
| **GitHub (this repo)** | ✅ Ready | Primary distribution; clone + install scripts |
| **SSH install on Gold/Purple** | ✅ Ready | Standard admin path today |
| **Docker dashboard** | ✅ Ready | `docker-compose.yml` included |
| **Firewalla App Store** | ❓ No public SDK | Contact Firewalla for partner/App integration |
| **Bundled in firmware** | ❓ Requires partnership | Would need Firewalla engineering |

There is currently **no public third-party App submission portal** like iOS App Store. Community tools for Gold/Purple typically distribute via GitHub + SSH install, which is what this repo provides. For official integration, email or forum contact with Firewalla is the recommended path.

---

# For Firewalla team — review & test guide

Thank you for reviewing this community project. This document is written for Firewalla engineers and QA to evaluate the tool safely on Gold/Purple hardware.

## What this is

An **optional** Xbox gaming network monitor that:

- Reads connection data via **netbot API** (flows, hosts, policies) and Firewalla Redis/conntrack
- Classifies gaming server hostnames (PlayFab, CDN, telemetry, etc.)
- Applies optional per-destination DSCP marks via `iptables mangle`
- Probes IPv4/IPv6 paths and optionally **blocks slow alternate routes** for Xbox traffic only

**It does not modify Firewalla core**, firmware, or the mobile app. Scripts install under `/home/pi/gaming-tools/`. The dashboard uses **LAN HTTP only** — no SSH to the box.

## Recommended test setup

| Item | Suggestion |
|------|------------|
| Hardware | Firewalla Gold (dual ifb SQM) |
| Firmware | Current stable (6.x / release_7_0 branch) |
| LAN API | [array-firewalla-api](https://github.com/advancedresearcharray/array-firewalla-api) on `:9378` |
| Xbox | One console on LAN, DHCP reservation |
| Dashboard | Separate Linux host OR Docker on LAN (see INSTALL.md) |

## 15-minute test plan

### Step 1 — Bootstrap LAN API + push scripts (3 min)

Install `array-firewalla-api` on the box (one-time). From a LAN host:

```bash
export FIREWALLA_API_URL=http://A.A.A.A:9378
export FIREWALLA_API_TOKEN=<token>
./scripts/push-firewalla-tools-api.sh
```

Edit `/home/pi/gaming-tools/gaming.conf` with test Xbox IP/MAC.

### Step 2 — Smoke test collector (1 min)

```bash
curl -sS -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-snapshot.sh","args":["B.B.B.B"],"sudo":false}' | python3 -m json.tool | head -60
```

**Expected:** JSON with `xbox`, `connections`, `destinations`, `wan`, `sqm`, `flowSource: netbot`.

### Step 3 — Install dashboard (5 min)

On a LAN Linux host:

```bash
sudo FIREWALLA_API_URL=http://A.A.A.A:9378 \
     FIREWALLA_API_TOKEN=<token> \
     XBOX_IP=B.B.B.B \
     ./scripts/install-dashboard.sh
```

Open `http://C.C.C.C:9377/` — verify live metrics with Xbox online.

### Step 4 — Gaming session test (5 min)

1. Launch an online game (e.g. CoD, Fortnite, Halo)
2. Confirm **Connecting to** table populates with hostnames
3. Click **Probe routes now** — datacenter ranking should appear
4. Verify **Enforce best paths** shows blocked slow region IPs

### Step 5 — Verify firewall rules (2 min)

```bash
curl -sS -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-route-enforce.sh","args":["status"],"sudo":true}'
```

**Expected:** `enabled=active`, DROP chain, ipset entries for slow region probe IPs.

### Step 6 — Clean uninstall

```bash
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-route-enforce.sh","args":["off"],"sudo":true}'
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" -X POST "$FIREWALLA_API_URL/api/v1/run" \
  -d '{"script":"gaming-role-qos.sh","args":["off"],"sudo":true}'
```

Confirm `iptables -L XBOX_ROUTE_ENFORCE` and ipsets are gone (on-box console if needed).

---

## Security review checklist

- [ ] Scripts run via API allowlist; QoS/enforcement use `sudo` on-box only
- [ ] No credentials stored in repo
- [ ] Dashboard uses bearer token + LAN CIDR allowlist (no SSH)
- [ ] iptables rules scoped to Xbox source IP(s) only
- [ ] ipset entries are specific /32 (or /128) host routes, not broad CIDR blocks
- [ ] No writes to `/home/pi/firewalla` or system directories
- [ ] Uninstall removes all chains, jumps, and ipsets

## Questions for Firewalla

1. **Supported third-party API** — Is netbot-over-LAN the right long-term path vs. a documented public API?
2. **App platform** — Path to ship this as an official Firewalla App container on Gold?
3. **Policy integration** — Should route enforcement go through Firerouter/policy engine instead of raw iptables?
4. **IPv6** — Recommended approach for dual-stack gaming on Purple/Gold?
5. **Redis / netbot schema** — Stability of `conn:*` and `flows` across firmware versions?

## How to share feedback

| Channel | Action |
|---------|--------|
| **[firewalla/firewalla Issues](https://github.com/firewalla/firewalla/issues)** | **Recommended** — official OS repo; open a feature/discussion issue linking to this project |
| **[firewalla/firewalla PRs](https://github.com/firewalla/firewalla)** | For core integration (e.g. `extension/gaming`); requires AGPL-3.0 compliance |
| **GitHub Issues (this repo)** | Bug reports, feature requests on the standalone monitor |
| **Email** | help@firewalla.com — subject: `Community: Xbox Gaming Monitor review` |
| **Forum** | Post on forum.firewalla.com with link to repo (Tips & Tricks) |
| **Pull requests** | Welcome for Firewalla-specific improvements on either repo |

### Relationship to firewalla/firewalla

[github.com/firewalla/firewalla](https://github.com/firewalla/firewalla) is Firewalla's **open-source core** (AGPL-3.0). It runs on the box at `/home/pi/firewalla`.

This Xbox monitor is a **standalone companion** (MIT license) that:

- Uses netbot + data Firewalla already collects
- Installs only under `/home/pi/gaming-tools/` — no core patches
- Could eventually be contributed back as an `extension/` module or official App

## Suggested email template

```
To: help@firewalla.com
Subject: Community: Xbox Gaming Monitor — review request

Hi Firewalla team,

We've built an open-source Xbox gaming traffic monitor that uses Firewalla Gold
for connection visibility, QoS, and route optimization:

  https://github.com/advancedresearcharray/firewalla-xbox-gaming-monitor

It installs optional scripts under /home/pi/gaming-tools/ and uses a LAN HTTP API
(array-firewalla-api) — no SSH from the dashboard. See docs/FIREWALLA-REVIEW.md
for a 15-minute test plan.

We'd appreciate your review for safety/compatibility and any guidance on
official App integration.

Thanks,
[Your name]
```

## Distribution paths (current landscape)

| Path | Status | Notes |
|------|--------|-------|
| **This repo (standalone)** | ✅ Ready | MIT — LAN API deploy, no core changes |
| **array-firewalla-api** | ✅ Ready | Bearer auth, netbot bridge, script runner |
| **[firewalla/firewalla](https://github.com/firewalla/firewalla) Issue** | ✅ Best contact | Link this project; ask about `extension/` integration |
| **firewalla/firewalla PR** | 🔜 Future | Native integration; must comply with AGPL-3.0 |
| **Docker dashboard** | ✅ Ready | `docker-compose.yml` included |

Official contribution policy on their repo: *"Please submit a pull request for any bugfix or improvement"* — development on `master`, stable on `release_6_0` / `release_7_0`.

---

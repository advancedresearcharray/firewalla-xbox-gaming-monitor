# Architecture

## Data flow

```
Xbox ──▶ Firewalla (bridge/NAT) ──▶ WAN
              │
              ├── netbot flows/hosts (official API)
              ├── conntrack / Redis conn:* keys (fallback)
              ├── tcpdump (optional sample window)
              ├── ping (latency to destinations)
              └── ifb/SQM stats
              │
              ▼
         gaming-snapshot.sh  ──JSON──▶  LAN HTTP API  ◀──  server.mjs  ◀──  Browser
              │                         (:9378 bearer)
              ├── gaming-route-probe.sh  (scheduled / on-demand via API)
              └── gaming-route-enforce.sh  (iptables blocks via API)
```

The dashboard talks to **array-firewalla-api** over HTTP on the LAN. It never opens SSH to Firewalla.

## Firewalla dependencies

The snapshot collector uses data already available on Firewalla Gold:

| Source | Used for |
|--------|----------|
| netbot `hosts` / `flows` | Device profile, recent flows (primary) |
| `redis-cli KEYS conn:*` | Active connections, DNS history (fallback) |
| `/proc/net/nf_conntrack` | Connection tracking fallback |
| `ip -6 neigh` | Xbox IPv6 from MAC |
| `ping` / `traceroute` | Latency and path analysis |
| `ifb0` / `ifb1` | SQM bandwidth stats |
| netbot `policies` | Device QoS / gaming priority baseline |

No patches to Firewalla core (`/home/pi/firewalla`) are required.

## Route enforcement model

On each probe:

1. Resolve all IPv4/IPv6 addresses per target hostname
2. Ping each candidate; pick lowest RTT
3. Build block list:
   - Alternate stacks ≥5 ms slower than chosen path
   - Azure region probe IPs ≥35 ms slower than best region
4. Sync to `ipset` + `iptables FORWARD` DROP for Xbox source only

This forces the Xbox to retry on faster paths without affecting other LAN devices.

## QoS model

**Official path (competitive bandwidth):** netbot `policy:create` with `action: qos` for static caps and device priority (`lib/qos-netbot.mjs`).

**Companion path (role tiers):** `gaming-role-qos.sh` maps destination IPs to ipsets by tier:

| Tier | DSCP | Roles |
|------|------|-------|
| Critical | EF | Matchmaking, Xbox Live session |
| High | AF41 | Game assets / CDN |
| Low | CS1 | Telemetry (deprioritized in Competitive profile) |

Works alongside Firewalla device-level gaming QoS (policies 569/570).

## File layout on Firewalla

```
/home/pi/gaming-tools/
├── gaming.conf              # Local config (XBOX_IP, MAC, LAN_IF)
├── gaming-snapshot.sh
├── gaming-role-qos.sh
├── gaming-route-probe.sh
├── gaming-route-enforce.sh
├── gaming-flood-guard.sh       # defend | harden | relax
├── gaming-packet-shield.sh     # shield | strict | relax (tiny-packet filter)
├── gaming-packet-capture.sh    # deep tcpdump JSON
├── gaming-buffer-tune.sh       # normal | light | desync | kick | max
├── gaming-moca-tune.sh
├── route-probes.json        # Azure region probes + thresholds
├── .traffic-profile.state   # QoS state
└── .route-enforce.state     # Enforcement state

/home/pi/array-firewalla-api/   # LAN HTTP API + netbot bridge
```

## Dashboard layout

```
/opt/xbox-traffic-monitor/   (or Docker mount)
├── server.mjs
├── lib/roles.mjs            # Server role classification
├── lib/qos-netbot.mjs       # Official policy:* QoS helpers
├── lib/routes.mjs           # Route analysis + enforcement builder
├── data/server-roles.json   # Hostname → role rules
├── data/route-probes.json
└── public/                  # Static dashboard
```

## Future native integration options

For Firewalla product team consideration:

1. **Bundled App** — run dashboard as container on Gold (similar to existing App platform)
2. **Native UI panel** — expose snapshot JSON via supported App API (this project uses netbot bridge today)
3. **Built-in route policy** — integrate enforcement into Firerouter/policy engine
4. **Gaming profile preset** — one-tap "Competitive Xbox" combining QoS + route enforce

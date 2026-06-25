# Warzone Lobby Sentinel

Autonomous cheater-lobby detection for Xbox Warzone over Firewalla. Polls `gaming-snapshot.sh` via [array-firewalla-api](../README.md), scores lobbies, pushes phone alerts, and optionally applies **packet shield** (tiny-packet filter) on the Firewalla path.

## Runtime

Primary deployment uses the **Rust** binary (`rust/`). Legacy Python modules under `sentinel/` are retained for reference.

## Deploy (CT941 / Proxmox LXC example)

```bash
cd rust && cargo build --release
bash deploy-to-lxc.sh
```

Configure `warzone-lobby-sentinel.env` from `warzone-lobby-sentinel.env.example`:

- `FIREWALLA_API_URL` — LAN API on Firewalla (`http://192.168.167.1:9378`)
- `WZ_XBOX_IP` — Xbox IPv4

## Dashboard

- `http://<sentinel-host>:8098/` — live cheater verdict, packet/inbound analysis, actions (mark lobby, kicked, stop defenses)

## Network guard (Firewalla scripts)

| Mode | Script | When |
|------|--------|------|
| Packet shield | `gaming-packet-shield.sh shield` | In-match on LIKELY/POSSIBLE — drops ≤79B floods, normal game UDP passes |
| Flood defend | `gaming-flood-guard.sh defend` | Matchmaking / confirmed kick spike |
| Buffers | `gaming-buffer-tune.sh apply light` | Matchmaking only (not in-match — avoids aim lag) |

Push scripts to Firewalla:

```bash
FIREWALLA_API_URL=http://A.A.A.A:9378 ./scripts/push-firewalla-tools-api.sh
```

(from repo root)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

static ROLES: OnceLock<Vec<RoleRule>> = OnceLock::new();

#[derive(Clone)]
struct RoleRule {
    id: String,
    match_patterns: Vec<String>,
    exclude: Vec<String>,
}

fn load_roles() -> &'static Vec<RoleRule> {
    ROLES.get_or_init(|| {
        let path = std::env::var("WZ_ROLES_FILE")
            .unwrap_or_else(|_| "/opt/warzone-lobby-sentinel/data/server-roles.json".into());
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| include_str!("../../data/server-roles.json").into());
        let v: Value = serde_json::from_str(&raw).unwrap_or(json!({"rules": []}));
        v["rules"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|r| {
                Some(RoleRule {
                    id: r["id"].as_str()?.to_string(),
                    match_patterns: r["match"]
                        .as_array()?
                        .iter()
                        .filter_map(|x| x.as_str().map(str::to_lowercase))
                        .collect(),
                    exclude: r
                        .get("matchExclude")
                        .and_then(|x| x.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_lowercase))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
            .collect()
    })
}

pub fn classify_host(hostname: &str) -> String {
    let host = hostname.to_lowercase();
    if host.is_empty() {
        return "unknown".into();
    }
    for rule in load_roles() {
        if rule.exclude.iter().any(|x| host.contains(x)) {
            continue;
        }
        if rule.match_patterns.iter().any(|p| host.contains(p)) {
            return rule.id.clone();
        }
    }
    "unknown".into()
}

fn is_ipish(h: &str) -> bool {
    !h.is_empty() && h.replace('.', "").chars().all(|c| c.is_ascii_digit())
}

fn flow_hosts(snapshot: &Value) -> Vec<String> {
    let mut hosts = Vec::new();
    for key in ["recentFlows", "recent_flows"] {
        if let Some(flows) = snapshot.get(key).and_then(|v| v.as_array()) {
            for flow in flows {
                let h = flow
                    .get("hostname")
                    .or(flow.get("host"))
                    .or(flow.get("label"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !h.is_empty() && !is_ipish(h) {
                    hosts.push(h.to_string());
                }
            }
        }
    }
    for key in ["dnsDestinations", "dns_destinations"] {
        if let Some(buckets) = snapshot.get(key).and_then(|v| v.as_array()) {
            for b in buckets {
                if let Some(h) = b.get("hostname").or(b.get("label")).and_then(|v| v.as_str()) {
                    if !h.is_empty() {
                        hosts.push(h.to_string());
                    }
                }
            }
        }
    }
    if let Some(items) = snapshot
        .pointer("/connections/items")
        .and_then(|v| v.as_array())
    {
        for item in items {
            let h = item
                .get("hostname")
                .or(item.get("host"))
                .or(item.get("label"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !h.is_empty() && !is_ipish(h) {
                hosts.push(h.to_string());
            }
        }
    }
    hosts
}

pub fn enrich_snapshot(mut snapshot: Value) -> Value {
    if snapshot.get("error").is_some() || snapshot.is_null() {
        return snapshot;
    }

    let mut role_counts: HashMap<String, u32> = HashMap::new();
    let mut classified = Vec::new();
    for host in flow_hosts(&snapshot) {
        let rid = classify_host(&host);
        *role_counts.entry(rid.clone()).or_default() += 1;
        if rid != "unknown" && classified.len() < 20 {
            classified.push(json!({"hostname": host, "roleId": rid}));
        }
    }

    let xbox_online = snapshot
        .pointer("/xbox/online")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let conns = snapshot
        .pointer("/connections/count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let mut game = "unknown".to_string();
    if role_counts.contains_key("warzone-game")
        || role_counts.contains_key("game-assets")
        || role_counts.contains_key("telemetry")
    {
        game = "warzone".into();
    } else if role_counts.contains_key("xbox-live") && xbox_online {
        game = "warzone".into();
    }

    let phase = infer_phase(&role_counts, xbox_online, conns, &game);

    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert(
            "_enriched".into(),
            json!({
                "roleCounts": role_counts,
                "classified": classified,
                "phase": phase,
                "game": game,
            }),
        );
    }
    snapshot
}

fn infer_phase(
    roles: &HashMap<String, u32>,
    xbox_online: bool,
    conns: u32,
    game: &str,
) -> &'static str {
    if roles.get("warzone-game").copied().unwrap_or(0) >= 1 {
        return "in-match";
    }
    if roles.get("matchmaking").copied().unwrap_or(0) >= 1 {
        return "matchmaking";
    }
    if roles.get("azure-qos").copied().unwrap_or(0) >= 2 && conns >= 80 {
        return "matchmaking";
    }
    // In-match without Demonware DNS (common on Xbox UDP): heavy CoD + telemetry load.
    if game == "warzone"
        && xbox_online
        && conns >= 65
        && roles.get("game-assets").copied().unwrap_or(0) >= 2
        && roles.get("telemetry").copied().unwrap_or(0) >= 2
    {
        return "in-match";
    }
    // Queue / pre-game lobby: PlayFab or QoS churn with elevated fan-out.
    if xbox_online
        && conns >= 40
        && (roles.get("matchmaking").copied().unwrap_or(0) > 0
            || roles.get("azure-qos").copied().unwrap_or(0) >= 2)
    {
        return "matchmaking";
    }
    if xbox_online && conns >= 15 {
        return "background";
    }
    if !xbox_online && conns == 0 {
        return "idle";
    }
    "background"
}

pub fn role_index(role: &str) -> u8 {
    match role {
        "warzone-game" => 1,
        "matchmaking" => 2,
        "game-assets" => 3,
        "telemetry" => 4,
        "xbox-live" => 5,
        "azure-qos" => 6,
        "notifications" => 7,
        _ => 0,
    }
}

pub fn phase_code(phase: &str) -> u8 {
    match phase {
        "idle" => 0,
        "background" => 1,
        "matchmaking" => 2,
        "in-match" => 3,
        "post-match" => 4,
        _ => 1,
    }
}

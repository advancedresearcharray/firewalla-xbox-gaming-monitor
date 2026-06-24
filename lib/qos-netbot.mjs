/**
 * Official Firewalla QoS via netbot policy:* (control/QoS.js + PolicyManager2).
 * Companion to custom role-qos (DSCP tiers) and buffer-tune (NIC/sysctl).
 */

export const QOS_NOTES = {
  bandwidthUpload: "xbox-monitor:bandwidth:upload",
  bandwidthDownload: "xbox-monitor:bandwidth:download",
};

export function normalizeMac(mac) {
  return (mac || "").toUpperCase().replace(/-/g, ":");
}

export function parsePolicies(result) {
  const data = result?.data ?? result ?? {};
  return Array.isArray(data.policies) ? data.policies : [];
}

export function qosPoliciesForMac(policies, mac) {
  const norm = normalizeMac(mac);
  return policies.filter((p) => {
    if (String(p.action || "").toLowerCase() !== "qos") return false;
    if (String(p.disabled ?? "0") !== "0") return false;
    const scope = Array.isArray(p.scope) ? p.scope : [];
    return scope.map((s) => normalizeMac(s)).includes(norm);
  });
}

export async function resolveXboxMac(netbotFn, xboxIp) {
  if (!xboxIp) return null;
  const result = await netbotFn("get", { item: "hosts" });
  const data = result?.data ?? result ?? {};
  const hosts = data.hosts ?? [];
  const list = Array.isArray(hosts) ? hosts : Object.values(hosts);
  const match = list.find((h) => h?.ip === xboxIp);
  return match?.mac ? normalizeMac(match.mac) : null;
}

async function policyCreate(netbotFn, value) {
  const result = await netbotFn("cmd", { item: "policy:create", value });
  const data = result?.data ?? result ?? {};
  return data.pid ?? data.policy?.pid ?? data;
}

async function policyUpdate(netbotFn, pid, patch) {
  return netbotFn("cmd", { item: "policy:update", value: { pid, ...patch } });
}

async function policyDelete(netbotFn, pid) {
  return netbotFn("cmd", { item: "policy:delete", value: { policyID: pid } });
}

export async function listPolicies(netbotFn) {
  const result = await netbotFn("get", { item: "policies" });
  return parsePolicies(result);
}

export async function ensureMacQosRule(netbotFn, mac, { trafficDirection, rateLimit, priority, notes }) {
  const policies = await listPolicies(netbotFn);
  const scoped = qosPoliciesForMac(policies, mac);
  const existing = scoped.find((p) => p.notes === notes);
  const value = {
    type: "mac",
    action: "qos",
    direction: "bidirection",
    trafficDirection,
    scope: [normalizeMac(mac)],
    qdisc: "fq_codel",
    disabled: "0",
    notes,
  };
  if (rateLimit != null) value.rateLimit = rateLimit;
  if (priority != null) value.priority = priority;

  if (existing?.pid) {
    await policyUpdate(netbotFn, existing.pid, value);
    return existing.pid;
  }
  return policyCreate(netbotFn, value);
}

export async function removePoliciesByNotes(netbotFn, mac, notePrefix) {
  const policies = qosPoliciesForMac(await listPolicies(netbotFn), mac);
  const removed = [];
  for (const p of policies) {
    if (!p.notes?.startsWith(notePrefix)) continue;
    if (!p.pid) continue;
    await policyDelete(netbotFn, p.pid);
    removed.push(p.pid);
  }
  return removed;
}

export async function ensureStaticBandwidthCaps(netbotFn, mac, uploadMbps, downloadMbps) {
  const uploadPid = await ensureMacQosRule(netbotFn, mac, {
    trafficDirection: "upload",
    rateLimit: uploadMbps,
    priority: 4,
    notes: QOS_NOTES.bandwidthUpload,
  });
  const downloadPid = await ensureMacQosRule(netbotFn, mac, {
    trafficDirection: "download",
    rateLimit: downloadMbps,
    priority: 4,
    notes: QOS_NOTES.bandwidthDownload,
  });
  return {
    mode: "static",
    uploadMbps,
    downloadMbps,
    uploadPid,
    downloadPid,
    via: "netbot",
  };
}

export async function ensureDynamicBandwidth(netbotFn, mac) {
  const removed = await removePoliciesByNotes(netbotFn, mac, "xbox-monitor:bandwidth:");
  return { mode: "dynamic", removed, via: "netbot" };
}

export async function removeBandwidthCaps(netbotFn, mac) {
  const removed = await removePoliciesByNotes(netbotFn, mac, "xbox-monitor:bandwidth:");
  return { mode: "off", removed, via: "netbot" };
}

/** Mirror gaming-snapshot detect_gaming_mode using official policies API. */
export async function detectGamingQosMode(netbotFn, mac) {
  if (!mac) return { mode: "unknown", detail: "no-mac-configured" };
  const policies = qosPoliciesForMac(await listPolicies(netbotFn), mac);
  let upload = false;
  let download = false;
  const pids = [];
  for (const p of policies) {
    if (p.notes?.startsWith("xbox-monitor:bandwidth:")) continue;
    pids.push(String(p.pid));
    if (p.trafficDirection === "upload") upload = true;
    if (p.trafficDirection === "download") download = true;
  }
  if (upload && download) {
    return { mode: "on", detail: `firewalla-qos ${[...new Set(pids)].sort().join(",")}` };
  }
  if (upload || download) {
    return { mode: "partial", detail: `firewalla-qos-one-way ${[...new Set(pids)].sort().join(",")}` };
  }
  return { mode: "off", detail: "firewalla-qos-inactive" };
}

export function netbotQosEnabled() {
  return process.env.USE_NETBOT_QOS !== "0";
}

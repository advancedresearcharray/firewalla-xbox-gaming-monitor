import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRolesConfig } from "./roles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = path.join(__dirname, "..", "data", "runtime-policy.json");
const PROFILE_PATH = path.join(__dirname, "..", "data", "runtime-traffic-profile.json");

const DEFAULT_POLICY = {
  bandwidth: {
    mode: "static",
    uploadMbps: 500,
    downloadMbps: 500,
  },
  buffers: {
    mode: "large",
  },
  dns: {
    enabled: false,
    primary: "1.1.1.1",
    secondary: "1.0.0.1",
  },
};

let cachedPolicy = null;

export function loadPolicy() {
  if (cachedPolicy) return cachedPolicy;
  if (existsSync(POLICY_PATH)) {
    cachedPolicy = { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(POLICY_PATH, "utf8")) };
    cachedPolicy.bandwidth = { ...DEFAULT_POLICY.bandwidth, ...cachedPolicy.bandwidth };
    cachedPolicy.buffers = { ...DEFAULT_POLICY.buffers, ...cachedPolicy.buffers };
    cachedPolicy.dns = { ...DEFAULT_POLICY.dns, ...cachedPolicy.dns };
    return cachedPolicy;
  }
  cachedPolicy = structuredClone(DEFAULT_POLICY);
  return cachedPolicy;
}

export function savePolicy(policy) {
  cachedPolicy = policy;
  writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2));
}

export function getCompetitiveDefaults() {
  const roles = loadRolesConfig();
  const comp = roles.profiles?.competitive || {};
  const bw = comp.bandwidth || {};
  const buf = comp.buffers || {};
  const dns = comp.dns || {};
  return {
    bandwidth: {
      mode: bw.mode || "static",
      uploadMbps: bw.static?.uploadMbps ?? 500,
      downloadMbps: bw.static?.downloadMbps ?? 500,
    },
    buffers: {
      mode: buf.mode || "large",
    },
    dns: {
      enabled: dns.enabled === true,
      primary: (dns.resolvers || [])[0] || "1.1.1.1",
      secondary: (dns.resolvers || [])[1] || "1.0.0.1",
    },
  };
}

export function mergePolicy(updates = {}) {
  const current = loadPolicy();
  const next = {
    bandwidth: { ...current.bandwidth, ...(updates.bandwidth || {}) },
    buffers: { ...current.buffers, ...(updates.buffers || {}) },
    dns: { ...current.dns, ...(updates.dns || {}) },
  };
  if (next.bandwidth.mode !== "static") {
    next.bandwidth.mode = "dynamic";
  }
  const validBuffers = new Set(["normal", "large", "max"]);
  if (!validBuffers.has(next.buffers.mode)) {
    next.buffers.mode = "large";
  }
  if (typeof next.dns.enabled !== "boolean") {
    next.dns.enabled = false;
  }
  savePolicy(next);
  return next;
}

export function loadTrafficProfile(validProfiles = null) {
  if (!existsSync(PROFILE_PATH)) return "balanced";
  try {
    const profile = JSON.parse(readFileSync(PROFILE_PATH, "utf8")).profile;
    if (!profile) return "balanced";
    if (validProfiles && !validProfiles[profile]) return "balanced";
    return profile;
  } catch {
    return "balanced";
  }
}

export function saveTrafficProfile(profile) {
  writeFileSync(PROFILE_PATH, JSON.stringify({ profile }, null, 2));
}

export function policySummary(policy = loadPolicy()) {
  const bw =
    policy.bandwidth.mode === "static"
      ? `static ↑${policy.bandwidth.uploadMbps} ↓${policy.bandwidth.downloadMbps} Mbps`
      : "dynamic (Firewalla allocates)";
  const dns = policy.dns.enabled
    ? `Xbox-only → ${policy.dns.primary}${policy.dns.secondary ? ` / ${policy.dns.secondary}` : ""}`
    : "default (network DNS, all devices use router settings)";
  const burst =
    policy.buffers.mode === "max"
      ? "max (4M Xbox tc burst + NIC rings)"
      : policy.buffers.mode === "large"
        ? "large (2M Xbox tc burst + NIC rings)"
        : "normal (512k Xbox tc burst)";
  return { bandwidth: bw, buffers: burst, dns };
}

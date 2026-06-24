/**
 * Detect inbound floods / boot patterns on Xbox traffic and drive auto-adjustments.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_PATH = path.join(__dirname, "..", "data", "security-events.ndjson");
const STATE_PATH = path.join(__dirname, "..", "data", "security-state.json");

const HISTORY_MAX = 90;
const GUARD_COOLDOWN_MS = 120_000;
const GUARD_MIN_ACTIVE_MS = 45_000;

/** @type {{ history: object[], alerts: object[], guardActive: boolean, guardSince: number|null, lastGuardAction: number, baseline: object|null }} */
let state = loadState();

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return {
      history: [],
      alerts: [],
      guardActive: false,
      guardSince: null,
      lastGuardAction: 0,
      baseline: null,
    };
  }
  try {
    return { ...JSON.parse(readFileSync(STATE_PATH, "utf8")), alerts: [] };
  } catch {
    return {
      history: [],
      alerts: [],
      guardActive: false,
      guardSince: null,
      lastGuardAction: 0,
      baseline: null,
    };
  }
}

function saveState() {
  const { history, guardActive, guardSince, lastGuardAction, baseline } = state;
  writeFileSync(
    STATE_PATH,
    JSON.stringify({ history, guardActive, guardSince, lastGuardAction, baseline }, null, 2),
  );
}

function logEvent(entry) {
  appendFileSync(EVENTS_PATH, `${JSON.stringify(entry)}\n`);
}

function median(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function sampleMetrics(snapshot) {
  const sample = snapshot?.sample || {};
  const windowSec = Number(sample.windowSec) || 3;
  const bytesIn = Number(sample.bytesIn) || 0;
  const bytesOut = Number(sample.bytesOut) || 0;
  const packets = Number(sample.packets) || 0;
  const conns = Number(snapshot?.connections?.count) || 0;
  const wanMs = snapshot?.wan?.latencyMs;

  const inboundMbps = (bytesIn * 8) / windowSec / 1_000_000;
  const outboundMbps = (bytesOut * 8) / windowSec / 1_000_000;
  const inboundKpps = packets > 0 && bytesIn >= bytesOut ? packets / windowSec / 1000 : 0;
  const totalKpps = packets / windowSec / 1000;

  return {
    at: Date.now(),
    inboundMbps: Math.round(inboundMbps * 100) / 100,
    outboundMbps: Math.round(outboundMbps * 100) / 100,
    inboundKpps: Math.round(inboundKpps * 100) / 100,
    totalKpps: Math.round(totalKpps * 100) / 100,
    connections: conns,
    wanLatencyMs: wanMs != null ? Number(wanMs) : null,
    xboxOnline: Boolean(snapshot?.xbox?.online),
  };
}

function updateBaseline() {
  const recent = state.history.slice(-40);
  if (recent.length < 8) return;
  state.baseline = {
    inboundMbps: median(recent.map((r) => r.inboundMbps)),
    outboundMbps: median(recent.map((r) => r.outboundMbps)),
    totalKpps: median(recent.map((r) => r.totalKpps)),
    connections: median(recent.map((r) => r.connections)),
    wanLatencyMs: median(recent.map((r) => r.wanLatencyMs).filter((n) => n != null)),
  };
}

function classifySample(m, baseline) {
  const alerts = [];
  let severity = "ok";
  let score = 0;

  const baseIn = baseline?.inboundMbps || 5;
  const baseOut = baseline?.outboundMbps || 1;
  const baseConn = baseline?.connections || 40;
  const baseKpps = baseline?.totalKpps || 0.08;

  if (m.inboundMbps > 80 && m.inboundMbps > baseIn * 4 && m.inboundMbps > m.outboundMbps * 2.5) {
    alerts.push({
      type: "inbound_flood",
      detail: `Inbound ${m.inboundMbps} Mbps (${Math.round(m.inboundMbps / Math.max(baseIn, 0.1))}× baseline) — possible boot/flood`,
    });
    score += 3;
  }

  if (m.totalKpps > Math.max(3, baseKpps * 8) && m.connections > baseConn * 1.8) {
    alerts.push({
      type: "packet_storm",
      detail: `${m.totalKpps} kpps, ${m.connections} connections — abnormal for Xbox gaming`,
    });
    score += 2;
  }

  if (m.connections > 120) {
    alerts.push({
      type: "connection_surge",
      detail: `${m.connections} active flows — lobby/boot attack pattern`,
    });
    score += 2;
  }

  if (
    m.outboundMbps > 12 &&
    m.outboundMbps > baseOut * 3 &&
    m.wanLatencyMs != null &&
    baseline?.wanLatencyMs != null &&
    m.wanLatencyMs > baseline.wanLatencyMs + 25
  ) {
    alerts.push({
      type: "upload_choke",
      detail: `Upload burst ${m.outboundMbps} Mbps with latency ${m.wanLatencyMs} ms — combat bufferbloat risk`,
    });
    score += 1;
  }

  if (m.inboundMbps > 200 || score >= 4) severity = "critical";
  else if (score >= 2) severity = "high";
  else if (score >= 1) severity = "warn";

  return { severity, score, alerts };
}

/**
 * Analyze one snapshot; update rolling history and return live telemetry.
 */
export function analyzeSecurityTelemetry(snapshot) {
  if (!snapshot) {
    return {
      status: "waiting",
      severity: "ok",
      guardActive: state.guardActive,
      metrics: null,
      baseline: state.baseline,
      alerts: [],
      recentEvents: tailEvents(12),
    };
  }

  const metrics = sampleMetrics(snapshot);
  state.history.push(metrics);
  if (state.history.length > HISTORY_MAX) state.history.shift();
  updateBaseline();

  const { severity, score, alerts } = classifySample(metrics, state.baseline);
  const now = Date.now();

  if (alerts.length) {
    for (const a of alerts) {
      const entry = { at: now, severity, ...a, metrics };
      state.alerts.push(entry);
      logEvent(entry);
    }
  }

  saveState();

  return {
    status: severity === "ok" ? "normal" : severity,
    severity,
    score,
    guardActive: state.guardActive,
    guardSince: state.guardSince,
    metrics,
    baseline: state.baseline,
    alerts: alerts.slice(-6),
    history: state.history.slice(-24),
    recentEvents: tailEvents(15),
    bandwidthCapMbps: { upload: 500, download: 500 },
  };
}

function tailEvents(n) {
  if (!existsSync(EVENTS_PATH)) return [];
  try {
    const lines = readFileSync(EVENTS_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-n).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function shouldActivateGuard(telemetry) {
  if (!telemetry?.metrics?.xboxOnline) return false;
  if (telemetry.severity === "critical") return true;
  if (telemetry.severity === "high" && telemetry.score >= 3) return true;
  return false;
}

export function shouldRelaxGuard(telemetry) {
  if (!state.guardActive) return false;
  const activeMs = state.guardSince ? Date.now() - state.guardSince : 0;
  if (activeMs < GUARD_MIN_ACTIVE_MS) return false;
  if (telemetry.severity === "critical" || telemetry.severity === "high") return false;
  const calm = state.history.slice(-4);
  if (calm.length < 3) return false;
  return calm.every((m) => m.inboundMbps < 40 && m.connections < 90);
}

export function markGuardActive(active) {
  state.guardActive = active;
  state.guardSince = active ? Date.now() : null;
  state.lastGuardAction = Date.now();
  saveState();
  logEvent({
    at: Date.now(),
    type: active ? "guard_on" : "guard_off",
    severity: active ? "high" : "ok",
    detail: active ? "Flood guard activated on Firewalla" : "Flood guard relaxed",
  });
}

export function guardActionCooldownReady() {
  return Date.now() - state.lastGuardAction > 15_000;
}

export function getSecurityState() {
  return {
    guardActive: state.guardActive,
    guardSince: state.guardSince,
    baseline: state.baseline,
    recentEvents: tailEvents(20),
  };
}

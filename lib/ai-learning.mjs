/**
 * Learning layer — history, adaptive thresholds, lobby prediction, rule suggestions.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "data", "ai-history.json");
const HOST_STATS_PATH = path.join(__dirname, "..", "data", "ai-host-stats.json");

const MAX_SAMPLES = 120;
const MIN_SAMPLES_FOR_ADAPT = 8;

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function avg(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pushSample(arr, sample, max = MAX_SAMPLES) {
  arr.push(sample);
  while (arr.length > max) arr.shift();
}

export function loadLearningState() {
  return {
    history: loadJson(HISTORY_PATH, {
      latency: [],
      bandwidth: [],
      regionSpread: [],
      matchmakingLatency: [],
    }),
    hostStats: loadJson(HOST_STATS_PATH, {}),
  };
}

export function recordSnapshot(snapshot, routeAnalysis = null) {
  const state = loadLearningState();
  const ts = snapshot?.timestamp || new Date().toISOString();

  const wanLat = snapshot?.wan?.latencyMs;
  if (wanLat != null) {
    pushSample(state.history.latency, { ts, ms: wanLat });
  }

  const windowSec = snapshot?.sample?.windowSec || 3;
  const bytesIn = snapshot?.sample?.bytesIn || 0;
  const bytesOut = snapshot?.sample?.bytesOut || 0;
  if (bytesIn + bytesOut > 0) {
    pushSample(state.history.bandwidth, {
      ts,
      downKbps: (bytesIn * 8) / windowSec / 1000,
      upKbps: (bytesOut * 8) / windowSec / 1000,
    });
  }

  const ranking = routeAnalysis?.regionRanking || [];
  if (ranking.length >= 2 && ranking[0]?.pingMs != null) {
    const worst = ranking[ranking.length - 1]?.pingMs;
    if (worst != null) {
      pushSample(state.history.regionSpread, {
        ts,
        spreadMs: worst - ranking[0].pingMs,
        bestRegion: ranking[0].region,
      });
    }
  }

  for (const item of [
    ...(snapshot?.destinations || []),
    ...(snapshot?.connections?.items || []),
  ]) {
    const host = (item.hostname || item.label || "").toLowerCase();
    if (!host) continue;

    if (!state.hostStats[host]) {
      state.hostStats[host] = {
        hostname: host,
        seen: 0,
        roleId: item.roleId || "unknown",
        latencies: [],
        lastIp: item.ip,
        lastPort: item.port,
      };
    }
    const stat = state.hostStats[host];
    stat.seen += 1;
    stat.roleId = item.roleId || stat.roleId;
    stat.lastIp = item.ip || stat.lastIp;
    stat.lastPort = item.port || stat.lastPort;
    if (item.latencyMs != null) {
      pushSample(stat.latencies, item.latencyMs, 40);
    }

    if (item.roleId === "matchmaking" && item.latencyMs != null) {
      pushSample(state.history.matchmakingLatency, {
        ts,
        ms: item.latencyMs,
        host,
      });
    }
  }

  saveJson(HISTORY_PATH, state.history);
  saveJson(HOST_STATS_PATH, state.hostStats);
  return state;
}

export function getAdaptiveThresholds(baseConfig = {}) {
  const base = baseConfig.enforcement || {};
  const state = loadLearningState();
  const spreads = state.history.regionSpread.map((s) => s.spreadMs).filter(Number.isFinite);
  const matchLat = state.history.matchmakingLatency.map((s) => s.ms).filter(Number.isFinite);

  let slowPathDeltaMs = base.slowPathDeltaMs ?? 5;
  let slowRegionDeltaMs = base.slowRegionDeltaMs ?? 35;

  if (spreads.length >= MIN_SAMPLES_FOR_ADAPT) {
    const p25 = percentile(spreads, 25);
    slowRegionDeltaMs = Math.round(Math.max(20, Math.min(60, p25 * 0.45)));
  }

  if (matchLat.length >= MIN_SAMPLES_FOR_ADAPT) {
    const latP50 = percentile(matchLat, 50);
    slowPathDeltaMs = Math.round(Math.max(3, Math.min(12, latP50 * 0.15)));
  }

  return {
    slowPathDeltaMs,
    slowRegionDeltaMs,
    source: spreads.length >= MIN_SAMPLES_FOR_ADAPT ? "learned" : "default",
    samples: {
      regionSpread: spreads.length,
      matchmakingLatency: matchLat.length,
    },
  };
}

export function detectBandwidthSpikes(snapshot) {
  const state = loadLearningState();
  const bw = state.history.bandwidth;
  if (bw.length < 10) return [];

  const recent = bw.slice(-20);
  const downSamples = recent.map((b) => b.downKbps);
  const upSamples = recent.map((b) => b.upKbps);
  const downP90 = percentile(downSamples, 90) || 0;
  const upP90 = percentile(upSamples, 90) || 0;
  const current = bw[bw.length - 1];
  if (!current) return [];

  const spikes = [];
  const phaseItems = snapshot?.connections?.items || [];
  const inMatch =
    phaseItems.length >= 5 &&
    phaseItems.filter((i) => i.roleId === "telemetry").length / phaseItems.length < 0.4;

  if (current.downKbps > downP90 * 1.8 && current.downKbps > 5000) {
    spikes.push({
      type: "download-spike",
      severity: inMatch ? "high" : "medium",
      message: `Download spike ${current.downKbps.toFixed(0)} Kbps (baseline ~${downP90.toFixed(0)} Kbps)`,
      detail: inMatch
        ? "Large download during active match — may cause bufferbloat/lag"
        : "Heavy download — normal during patches",
    });
  }
  if (current.upKbps > Math.max(upP90 * 1.8, 500) && current.upKbps > 800) {
    spikes.push({
      type: "upload-spike",
      severity: inMatch ? "medium" : "low",
      message: `Upload spike ${current.upKbps.toFixed(0)} Kbps (baseline ~${upP90.toFixed(0)} Kbps)`,
      detail: "Upload burst — check for clip sharing or background sync",
    });
  }
  return spikes;
}

export function predictLobbyPlacement(snapshot, routeAnalysis) {
  const phase = snapshot?.aiInsights?.phase?.phase || null;
  const items = snapshot?.connections?.items || snapshot?.destinations || [];
  const matchmaking = items.filter((i) => i.roleId === "matchmaking");
  if (!matchmaking.length) return null;

  const bestRegion = routeAnalysis?.bestRegion;
  const bestPing = bestRegion?.pingMs;
  if (bestPing == null) return null;

  const worst = matchmaking.reduce((a, b) =>
    (b.latencyMs ?? 0) > (a.latencyMs ?? 0) ? b : a,
  );
  if (worst.latencyMs == null) return null;

  const delta = worst.latencyMs - bestPing;
  if (delta < 20) {
    return {
      risk: "low",
      score: Math.max(0, Math.round(delta)),
      detail: `Matchmaking path ~${worst.latencyMs.toFixed(0)} ms vs best region ${bestRegion.region} ${bestPing.toFixed(0)} ms`,
      hostname: worst.hostname,
    };
  }
  if (delta < 45) {
    return {
      risk: "medium",
      score: Math.round(delta),
      detail: `Possible distant lobby — ${worst.hostname} ${worst.latencyMs.toFixed(0)} ms (+${delta.toFixed(0)} ms vs ${bestRegion.region})`,
      hostname: worst.hostname,
      action: "Route enforcement may help on next queue",
    };
  }
  return {
    risk: "high",
    score: Math.round(delta),
    detail: `Likely bad lobby placement — ${worst.hostname} at ${worst.latencyMs.toFixed(0)} ms (+${delta.toFixed(0)} ms vs best ${bestRegion.region})`,
    hostname: worst.hostname,
    action: "Leave and re-queue; ensure path enforcement is on before matchmaking",
  };
}

export function suggestRoleRules(minSeen = 5, limit = 6) {
  const { hostStats } = loadLearningState();
  const classificationCache = loadJson(
    path.join(__dirname, "..", "data", "ai-classifications.json"),
    {},
  );

  const suggestions = [];
  for (const stat of Object.values(hostStats)) {
    if (stat.seen < minSeen || stat.roleId !== "unknown") continue;
    const ai = classificationCache[stat.hostname];
    if (!ai || ai.roleId === "unknown") continue;

    const pattern = stat.hostname.includes(".")
      ? stat.hostname.split(".").slice(-3).join(".")
      : stat.hostname;

    suggestions.push({
      id: ai.roleId,
      match: [pattern],
      role: ai.role,
      tier: ai.tier,
      detail: `${ai.detail} — seen ${stat.seen}x, avg latency ${avg(stat.latencies)?.toFixed(1) || "?"} ms`,
      hostname: stat.hostname,
      seen: stat.seen,
      source: "learned",
    });
  }

  return suggestions
    .sort((a, b) => b.seen - a.seen)
    .slice(0, limit);
}

export function buildLearningInsights(snapshot, routeAnalysis, baseEnforcement = {}) {
  const adaptive = getAdaptiveThresholds({ enforcement: baseEnforcement });
  const bandwidthSpikes = detectBandwidthSpikes(snapshot);
  const lobbyPrediction = predictLobbyPlacement(snapshot, routeAnalysis);
  const roleRuleSuggestions = suggestRoleRules();

  return {
    adaptiveThresholds: adaptive,
    bandwidthSpikes,
    lobbyPrediction,
    roleRuleSuggestions,
  };
}

/**
 * Learning layer — history, adaptive thresholds, outcomes, session memory.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compressJsonOnIngest,
  decompressJsonEnvelope,
  compressionEnabled,
} from "./array-compression-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "data", "ai-history.json");
const HOST_STATS_PATH = path.join(__dirname, "..", "data", "ai-host-stats.json");
const OUTCOMES_PATH = path.join(__dirname, "..", "data", "ai-outcomes.json");
const SESSIONS_PATH = path.join(__dirname, "..", "data", "ai-sessions.json");

const MAX_SAMPLES = 120;
const MIN_SAMPLES_FOR_ADAPT = 8;
const MAX_OUTCOMES = 200;
const MAX_SESSIONS = 40;
const OUTCOME_EVAL_MS = 5 * 60 * 1000;

const storageCache = new Map();

function isCompressedEnvelope(data) {
  return Boolean(data && typeof data === "object" && data._compressed);
}

function loadJson(filePath, fallback) {
  if (storageCache.has(filePath)) return storageCache.get(filePath);
  if (!existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (isCompressedEnvelope(parsed)) return fallback;
    storageCache.set(filePath, parsed);
    return parsed;
  } catch {
    return fallback;
  }
}

async function loadJsonAsync(filePath, fallback) {
  if (storageCache.has(filePath)) return storageCache.get(filePath);
  if (!existsSync(filePath)) {
    storageCache.set(filePath, fallback);
    return fallback;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const data = isCompressedEnvelope(raw) ? await decompressJsonEnvelope(raw) : raw;
    storageCache.set(filePath, data);
    return data;
  } catch {
    storageCache.set(filePath, fallback);
    return fallback;
  }
}

async function saveJsonAsync(filePath, data) {
  storageCache.set(filePath, data);
  if (compressionEnabled()) {
    try {
      const envelope = await compressJsonOnIngest(data);
      writeFileSync(filePath, JSON.stringify(envelope));
      return;
    } catch (err) {
      console.warn(
        `[learning] compress-on-ingest failed for ${path.basename(filePath)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Warm learning caches at startup (guide §5.3 — decompress folded-on-disk blobs). */
export async function initLearningStorage() {
  const historyFallback = {
    latency: [],
    bandwidth: [],
    regionSpread: [],
    matchmakingLatency: [],
    environment: [],
  };
  await Promise.all([
    loadJsonAsync(HISTORY_PATH, historyFallback),
    loadJsonAsync(HOST_STATS_PATH, {}),
    loadJsonAsync(OUTCOMES_PATH, { pending: [], completed: [] }),
    loadJsonAsync(SESSIONS_PATH, { active: null, completed: [] }),
  ]);
}

function persistLearningState(state) {
  return Promise.all([
    saveJsonAsync(HISTORY_PATH, state.history),
    saveJsonAsync(HOST_STATS_PATH, state.hostStats),
    saveJsonAsync(OUTCOMES_PATH, state.outcomes),
    saveJsonAsync(SESSIONS_PATH, state.sessions),
  ]);
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

export const GAME_SIGNATURES = [
  {
    id: "warzone",
    label: "Call of Duty / Warzone",
    match: ["demonware", "callofduty", "activision", "cod-"],
    roleIds: ["warzone-game"],
  },
  {
    id: "destiny2",
    label: "Destiny 2",
    match: ["bungie", "destga", "destiny2", "destiny.bungie"],
    roleIds: ["destiny2-game"],
  },
];

export function detectGameTitle(snapshot) {
  const items = [
    ...(snapshot?.connections?.items || []),
    ...(snapshot?.destinations || []),
  ];
  const scores = Object.fromEntries(GAME_SIGNATURES.map((g) => [g.id, 0]));

  for (const item of items) {
    const host = (item.hostname || item.label || "").toLowerCase();
    const roleId = item.roleId || "";
    for (const game of GAME_SIGNATURES) {
      if (game.roleIds.includes(roleId)) scores[game.id] += 3;
      if (game.match.some((p) => host.includes(p))) scores[game.id] += 2;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topId, topScore] = ranked[0] || [];
  if (!topScore) return { id: "unknown", label: "Xbox gaming", confidence: "low" };
  const game = GAME_SIGNATURES.find((g) => g.id === topId);
  return {
    id: topId,
    label: game?.label || topId,
    confidence: topScore >= 6 ? "high" : topScore >= 3 ? "medium" : "low",
    score: topScore,
  };
}

export function loadLearningState() {
  const history = loadJson(HISTORY_PATH, {
    latency: [],
    bandwidth: [],
    regionSpread: [],
    matchmakingLatency: [],
    environment: [],
  });
  if (!history.environment) history.environment = [];
  return {
    history,
    hostStats: loadJson(HOST_STATS_PATH, {}),
    outcomes: loadJson(OUTCOMES_PATH, { pending: [], completed: [] }),
    sessions: loadJson(SESSIONS_PATH, { active: null, completed: [] }),
  };
}

function extractEnvironment(snapshot, routeAnalysis, context = {}) {
  const proc = context.processor || {};
  const nh = context.networkHealth || snapshot?.networkHealth || {};
  const nat = nh.nat || {};
  const mtu = nh.mtu || {};
  const offload = nh.offload || {};
  const ranking = routeAnalysis?.regionRanking || [];
  const spread =
    ranking.length >= 2 && ranking[0]?.pingMs != null && ranking[ranking.length - 1]?.pingMs != null
      ? ranking[ranking.length - 1].pingMs - ranking[0].pingMs
      : null;

  return {
    load1: proc.load?.load1 ?? null,
    processorHealth: proc.health?.status ?? null,
    deferHeavyProbes: Boolean(proc.deferHeavyProbes),
    natType: nat.natType ?? null,
    doubleNat: Boolean(nat.wan?.doubleNat),
    mtuLowest: mtu.summary?.lowestMtu ?? null,
    offloadScore: offload.summary?.overallScore ?? null,
    routeSpreadMs: spread,
    bestRegion: routeAnalysis?.bestRegion?.region ?? null,
    enforcementActive: Boolean(routeAnalysis?.enforcementActive),
    trafficProfile: context.trafficProfile ?? null,
    gameId: detectGameTitle(snapshot).id,
  };
}

export function recordSnapshot(snapshot, routeAnalysis = null, context = {}) {
  const state = loadLearningState();
  const ts = snapshot?.timestamp || new Date().toISOString();
  const env = extractEnvironment(snapshot, routeAnalysis, context);

  pushSample(state.history.environment, { ts, ...env });

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

  updateSessionMemory(state, snapshot, routeAnalysis, context);
  evaluatePendingOutcomes(state, snapshot, routeAnalysis);

  void persistLearningState(state).catch((err) => {
    console.warn("[learning] persist failed:", err instanceof Error ? err.message : String(err));
  });
  return state;
}

function isGamingActive(snapshot) {
  const items = snapshot?.connections?.items || [];
  if (items.length === 0) return false;
  const gameRoles = new Set([
    "warzone-game",
    "destiny2-game",
    "matchmaking",
    "xbox-live",
    "game-assets",
  ]);
  return items.some((i) => gameRoles.has(i.roleId));
}

function updateSessionMemory(state, snapshot, routeAnalysis, context) {
  const game = detectGameTitle(snapshot);
  const phase = context.sessionPhase?.phase || "background";
  const active = isGamingActive(snapshot) || ["matchmaking", "in-match", "patch-download"].includes(phase);
  const now = Date.now();

  if (!state.sessions.active && active) {
    state.sessions.active = {
      id: `sess-${now}`,
      startedAt: now,
      gameId: game.id,
      gameLabel: game.label,
      trafficProfile: context.trafficProfile || "balanced",
      phases: [],
      events: [],
      bestRegion: routeAnalysis?.bestRegion?.region ?? null,
      peakMatchmakingMs: null,
      lobbyWarnings: 0,
    };
  }

  if (state.sessions.active) {
    const sess = state.sessions.active;
    sess.trafficProfile = context.trafficProfile || sess.trafficProfile;
    if (routeAnalysis?.bestRegion?.region) sess.bestRegion = routeAnalysis.bestRegion.region;

    const lastPhase = sess.phases[sess.phases.length - 1];
    if (!lastPhase || lastPhase.phase !== phase) {
      sess.phases.push({ phase, at: now, gameId: game.id });
    }

    const mm = (snapshot?.connections?.items || []).filter((i) => i.roleId === "matchmaking");
    for (const m of mm) {
      if (m.latencyMs != null) {
        sess.peakMatchmakingMs = Math.max(sess.peakMatchmakingMs || 0, m.latencyMs);
      }
    }

    if (!active && phase === "idle") {
      sess.endedAt = now;
      sess.durationSec = Math.round((now - sess.startedAt) / 1000);
      pushSample(state.sessions.completed, sess, MAX_SESSIONS);
      state.sessions.active = null;
    }
  }
}

export function recordSessionEvent(eventType, detail = {}) {
  const state = loadLearningState();
  if (!state.sessions.active) return;
  state.sessions.active.events.push({
    type: eventType,
    at: Date.now(),
    ...detail,
  });
  void persistLearningState(state).catch((err) => {
    console.warn("[learning] persist failed:", err instanceof Error ? err.message : String(err));
  });
}

export function recordRecommendationOutcomes(recommendations, snapshot, routeAnalysis) {
  const state = loadLearningState();
  const now = Date.now();
  const baseline = {
    wanLatencyMs: snapshot?.wan?.latencyMs ?? null,
    matchmakingMs: peakMatchmakingLatency(snapshot),
    routeSpreadMs: routeSpread(routeAnalysis),
    load1: (state.history.environment || []).at(-1)?.load1 ?? null,
  };

  for (const rec of recommendations || []) {
    if (!rec.action || rec.priority === "info") continue;
    const key = rec.outcomeKey || `${rec.action.type}:${rec.action.value ?? rec.title}`;
    const exists = state.outcomes.pending.some(
      (p) => p.key === key && now - p.recordedAt < OUTCOME_EVAL_MS,
    );
    if (exists) continue;

    state.outcomes.pending.push({
      id: `out-${now}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      title: rec.title,
      action: rec.action,
      recordedAt: now,
      evaluateAfter: now + OUTCOME_EVAL_MS,
      baseline,
    });
  }

  while (state.outcomes.pending.length > 80) state.outcomes.pending.shift();
  void saveJsonAsync(OUTCOMES_PATH, state.outcomes).catch((err) => {
    console.warn("[learning] outcomes persist failed:", err instanceof Error ? err.message : String(err));
  });
}

function peakMatchmakingLatency(snapshot) {
  const items = snapshot?.connections?.items || snapshot?.destinations || [];
  const mm = items.filter((i) => i.roleId === "matchmaking" && i.latencyMs != null);
  if (!mm.length) return null;
  return Math.max(...mm.map((i) => i.latencyMs));
}

function routeSpread(routeAnalysis) {
  const ranking = routeAnalysis?.regionRanking || [];
  if (ranking.length < 2 || ranking[0]?.pingMs == null) return null;
  const worst = ranking[ranking.length - 1]?.pingMs;
  return worst != null ? worst - ranking[0].pingMs : null;
}

function evaluatePendingOutcomes(state, snapshot, routeAnalysis) {
  const now = Date.now();
  const current = {
    wanLatencyMs: snapshot?.wan?.latencyMs ?? null,
    matchmakingMs: peakMatchmakingLatency(snapshot),
    routeSpreadMs: routeSpread(routeAnalysis),
    load1: (state.history.environment || []).at(-1)?.load1 ?? null,
  };

  const stillPending = [];
  for (const pending of state.outcomes.pending) {
    if (now < pending.evaluateAfter) {
      stillPending.push(pending);
      continue;
    }

    const result = scoreOutcome(pending, current);
    state.outcomes.completed.push({
      ...pending,
      completedAt: now,
      after: current,
      ...result,
    });
  }

  state.outcomes.pending = stillPending;
  while (state.outcomes.completed.length > MAX_OUTCOMES) state.outcomes.completed.shift();
}

function scoreOutcome(pending, current) {
  const b = pending.baseline || {};
  const improvements = [];
  const regressions = [];

  if (b.matchmakingMs != null && current.matchmakingMs != null) {
    const delta = b.matchmakingMs - current.matchmakingMs;
    if (delta >= 8) improvements.push(`matchmaking −${delta.toFixed(0)} ms`);
    else if (delta <= -8) regressions.push(`matchmaking +${Math.abs(delta).toFixed(0)} ms`);
  }
  if (b.wanLatencyMs != null && current.wanLatencyMs != null) {
    const delta = b.wanLatencyMs - current.wanLatencyMs;
    if (delta >= 5) improvements.push(`WAN −${delta.toFixed(0)} ms`);
    else if (delta <= -5) regressions.push(`WAN +${Math.abs(delta).toFixed(0)} ms`);
  }
  if (b.routeSpreadMs != null && current.routeSpreadMs != null) {
    const delta = b.routeSpreadMs - current.routeSpreadMs;
    if (delta >= 10) improvements.push(`route spread −${delta.toFixed(0)} ms`);
  }
  if (b.load1 != null && current.load1 != null) {
    const delta = b.load1 - current.load1;
    if (delta >= 0.3) improvements.push(`load −${delta.toFixed(2)}`);
  }

  let success = improvements.length > regressions.length;
  if (improvements.length === 0 && regressions.length === 0) success = null;

  return {
    success,
    improvements,
    regressions,
    verdict:
      success === true
        ? "helped"
        : success === false
          ? "no_clear_gain"
          : "inconclusive",
  };
}

export function getOutcomeStats(actionType = null, limit = 50) {
  const { outcomes } = loadLearningState();
  let completed = outcomes.completed || [];
  if (actionType) {
    completed = completed.filter((o) => o.action?.type === actionType);
  }
  completed = completed.slice(-limit);
  const helped = completed.filter((o) => o.verdict === "helped").length;
  const total = completed.filter((o) => o.verdict !== "inconclusive").length;
  return {
    total: completed.length,
    evaluated: total,
    helped,
    successRate: total > 0 ? helped / total : null,
    recent: completed.slice(-5).reverse(),
  };
}

export function getSessionInsights() {
  const { sessions, history } = loadLearningState();
  const completed = sessions.completed || [];
  const env = history.environment || [];
  const stressedEnv = (env || []).filter((e) => e.processorHealth === "stressed" || (e.load1 ?? 0) >= 1.5);
  const badLobbySessions = completed.filter((s) => (s.peakMatchmakingMs || 0) >= 70);

  return {
    active: sessions.active,
    completedCount: completed.length,
    recent: completed.slice(-5).reverse(),
    patterns: [
      stressedEnv.length >= 5
        ? `Firewalla stressed in ${stressedEnv.length} recent samples — probes may defer`
        : null,
      badLobbySessions.length >= 2
        ? `${badLobbySessions.length} recent sessions peaked ≥70 ms matchmaking`
        : null,
    ].filter(Boolean),
  };
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
      environment: (state.history.environment || []).length,
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

  const env = (state.history.environment || []).at(-1);
  const stressed = env?.processorHealth === "stressed" || (env?.load1 ?? 0) >= 1.4;

  if (current.downKbps > downP90 * 1.8 && current.downKbps > 5000) {
    spikes.push({
      type: "download-spike",
      severity: inMatch ? "high" : "medium",
      message: `Download spike ${current.downKbps.toFixed(0)} Kbps (baseline ~${downP90.toFixed(0)} Kbps)`,
      detail: inMatch
        ? stressed
          ? "Large download during match while Firewalla is stressed — high bufferbloat risk"
          : "Large download during active match — may cause bufferbloat/lag"
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

const HOSTNAME_PATTERNS = [
  { match: ["demonware.net", "demonware.pro", "prod.demonware"], roleId: "warzone-game", role: "Warzone game servers", tier: "critical", detail: "Demonware pattern" },
  { match: ["bungie.net", "destga.net", "destiny2.com", "destiny.bungie"], roleId: "destiny2-game", role: "Destiny 2 game servers", tier: "critical", detail: "Bungie/Destiny pattern" },
  { match: ["playfabapi.com", "playfab.com"], roleId: "matchmaking", role: "Matchmaking / sessions", tier: "critical", detail: "PlayFab pattern" },
  { match: ["xboxlive.com", "xbox.com", "mp.microsoft.com"], roleId: "xbox-live", role: "Xbox Live core", tier: "critical", detail: "Xbox Live pattern" },
  { match: ["cod-assets", "callofduty.com", "activision.com", "cdn.", "akamai", "cloudfront"], roleId: "game-assets", role: "Game assets / CDN", tier: "high", detail: "CDN/assets pattern" },
  { match: ["ingest.", "telemetry", "events.data.microsoft.com", "v10.events", "v20.events"], roleId: "telemetry", role: "Telemetry / analytics", tier: "low", detail: "Telemetry pattern" },
  { match: ["gamepass.com", "catalog.gamepass"], roleId: "gamepass", role: "Game Pass catalog", tier: "normal", detail: "Game Pass pattern" },
  { match: ["wns.windows.com", "notify"], roleId: "notifications", role: "Push notifications", tier: "normal", detail: "Notifications pattern" },
  { match: ["pki.goog", "ocsp.", "crl."], roleId: "tls-pki", role: "Certificate validation", tier: "normal", detail: "TLS/PKI pattern" },
  { match: ["cloudapp.azure.com", "mpsqosprod"], roleId: "azure-qos", role: "Azure QoS / region probes", tier: "normal", detail: "Azure probe pattern" },
];

export function classifyHostnamePattern(hostname) {
  const host = (hostname || "").toLowerCase();
  if (!host) return null;
  for (const rule of HOSTNAME_PATTERNS) {
    if (rule.match.some((p) => host.includes(p))) {
      return {
        roleId: rule.roleId,
        role: rule.role,
        tier: rule.tier,
        detail: rule.detail,
      };
    }
  }
  return null;
}

export function predictLobbyPlacement(snapshot, routeAnalysis) {
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

  const suggestions = [];
  for (const stat of Object.values(hostStats)) {
    if (stat.seen < minSeen || stat.roleId !== "unknown") continue;
    const guess = classifyHostnamePattern(stat.hostname);
    if (!guess || guess.roleId === "unknown") continue;

    const pattern = stat.hostname.includes(".")
      ? stat.hostname.split(".").slice(-3).join(".")
      : stat.hostname;

    suggestions.push({
      id: guess.roleId,
      match: [pattern],
      role: guess.role,
      tier: guess.tier,
      detail: `${guess.detail} — seen ${stat.seen}x, avg latency ${avg(stat.latencies)?.toFixed(1) || "?"} ms`,
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
  const game = detectGameTitle(snapshot);
  const outcomeStats = {
    trafficProfile: getOutcomeStats("traffic-profile"),
    routeEnforce: getOutcomeStats("route-enforce-on"),
    processorTune: getOutcomeStats("processor-tune"),
  };
  const sessions = getSessionInsights();

  return {
    adaptiveThresholds: adaptive,
    bandwidthSpikes,
    lobbyPrediction,
    roleRuleSuggestions,
    game,
    outcomeStats,
    sessions,
  };
}

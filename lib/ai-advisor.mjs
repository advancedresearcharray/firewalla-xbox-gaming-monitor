/**
 * AI advisor — local heuristics (always on) + optional LLM for classification and summaries.
 * Set AI_API_KEY (+ optional AI_BASE_URL, AI_MODEL) to enable LLM features.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningInsights,
  getAdaptiveThresholds,
  recordSnapshot,
  suggestRoleRules,
} from "./ai-learning.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "..", "data", "ai-classifications.json");

const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false" && Boolean(AI_API_KEY);

let classificationCache = loadCache();

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(classificationCache, null, 2));
}

export function aiStatus() {
  return {
    enabled: AI_ENABLED,
    model: AI_MODEL,
    hasApiKey: Boolean(AI_API_KEY),
    cachedClassifications: Object.keys(classificationCache).length,
  };
}

function unknownHosts(snapshot, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const item of [
    ...(snapshot?.destinations || []),
    ...(snapshot?.connections?.items || []),
  ]) {
    const host = (item.hostname || item.label || "").toLowerCase();
    if (!host || item.roleId !== "unknown" || seen.has(host)) continue;
    seen.add(host);
    out.push({ hostname: host, port: item.port, ip: item.ip });
    if (out.length >= limit) break;
  }
  return out;
}

function detectSessionPhase(snapshot) {
  const items = snapshot?.connections?.items || [];
  const roles = items.map((i) => i.roleId).filter(Boolean);
  const counts = {};
  for (const r of roles) counts[r] = (counts[r] || 0) + 1;

  if ((counts["game-assets"] || 0) >= 2 && (counts.matchmaking || 0) === 0) {
    return { phase: "patch-download", confidence: "high", detail: "Heavy CDN/asset traffic — likely downloading or patching" };
  }
  if ((counts.matchmaking || 0) >= 1 || (counts["xbox-live"] || 0) >= 2) {
    return { phase: "matchmaking", confidence: "high", detail: "PlayFab / Xbox Live active — lobby or session setup" };
  }
  if (items.length >= 5 && (counts.telemetry || 0) / items.length < 0.4) {
    return { phase: "in-match", confidence: "medium", detail: "Multiple live connections with gameplay-weighted traffic mix" };
  }
  if (items.length === 0) {
    return { phase: "idle", confidence: "high", detail: "No active WAN connections tracked" };
  }
  return { phase: "background", confidence: "low", detail: "Mixed background Xbox services" };
}

function detectAnomalies(snapshot, routeAnalysis) {
  const anomalies = [];
  const phase = detectSessionPhase(snapshot).phase;

  for (const d of snapshot?.destinations || []) {
    if (d.roleId === "matchmaking" && d.routePathQuality === "suboptimal") {
      anomalies.push({
        type: "suboptimal-matchmaking",
        severity: "high",
        message: `Matchmaking server ${d.hostname} path looks suboptimal vs best datacenter`,
        action: "Run route probe and keep path enforcement enabled",
      });
    }
    if (d.latencyMs != null && d.latencyMs >= 80 && d.tier === "critical") {
      anomalies.push({
        type: "high-latency-critical",
        severity: "high",
        message: `${d.hostname} at ${d.latencyMs.toFixed(0)} ms — high for critical tier`,
        action: "Check route ranking; verify enforcement is blocking slow regions",
      });
    }
  }

  if (phase === "in-match") {
    const telemetry = (snapshot?.connections?.items || []).filter((i) => i.roleId === "telemetry");
    const crit = (snapshot?.connections?.items || []).filter((i) => i.tier === "critical");
    if (telemetry.length > crit.length) {
      anomalies.push({
        type: "telemetry-noise",
        severity: "medium",
        message: "Telemetry connections rival gameplay traffic during match",
        action: "Switch to Competitive profile to deprioritize telemetry",
      });
    }
  }

  const ranking = routeAnalysis?.regionRanking || [];
  if (ranking.length >= 2 && ranking[0]?.pingMs != null && ranking[ranking.length - 1]?.pingMs != null) {
    const spread = ranking[ranking.length - 1].pingMs - ranking[0].pingMs;
    if (spread >= 80) {
      anomalies.push({
        type: "region-spread",
        severity: "medium",
        message: `${spread.toFixed(0)} ms spread between best (${ranking[0].region}) and worst (${ranking[ranking.length - 1].region}) datacenter paths`,
        action: "Path enforcement helps avoid distant Azure probe regions",
      });
    }
  }

  return anomalies;
}

function heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig = {}) {
  const recs = [];
  const phase = detectSessionPhase(snapshot);
  const anomalies = detectAnomalies(snapshot, routeAnalysis);
  const learning = buildLearningInsights(snapshot, routeAnalysis, enforcementConfig);

  recs.push({
    source: "heuristic",
    title: `Session phase: ${phase.phase.replace(/-/g, " ")}`,
    detail: phase.detail,
    priority: "info",
  });

  if (learning.adaptiveThresholds?.source === "learned") {
    recs.push({
      source: "learning",
      title: "Adaptive route thresholds active",
      detail: `Path delta ${learning.adaptiveThresholds.slowPathDeltaMs} ms, region delta ${learning.adaptiveThresholds.slowRegionDeltaMs} ms (from ${learning.adaptiveThresholds.samples.regionSpread} probes)`,
      priority: "info",
    });
  }

  if (learning.lobbyPrediction?.risk === "high") {
    recs.push({
      source: "learning",
      title: "Bad lobby placement likely",
      detail: learning.lobbyPrediction.detail,
      priority: "high",
      action: { type: "route-enforce-on" },
    });
  } else if (learning.lobbyPrediction?.risk === "medium") {
    recs.push({
      source: "learning",
      title: "Lobby path warning",
      detail: learning.lobbyPrediction.detail,
      priority: "medium",
    });
  }

  for (const spike of learning.bandwidthSpikes || []) {
    recs.push({
      source: "learning",
      title: spike.message,
      detail: spike.detail,
      priority: spike.severity,
    });
  }

  for (const rule of (learning.roleRuleSuggestions || []).slice(0, 3)) {
    recs.push({
      source: "learning",
      title: `Suggest rule: ${rule.hostname}`,
      detail: `${rule.role} (${rule.tier}) — ${rule.detail}`,
      priority: "low",
      action: { type: "apply-rule", value: rule },
    });
  }

  if (phase.phase === "in-match" && trafficProfile === "balanced") {
    recs.push({
      source: "heuristic",
      title: "Enable Competitive profile",
      detail: "In-match traffic detected — Competitive boosts matchmaking and deprioritizes telemetry",
      priority: "high",
      action: { type: "traffic-profile", value: "competitive" },
    });
  }

  if (phase.phase === "patch-download" && trafficProfile !== "download") {
    recs.push({
      source: "heuristic",
      title: "Enable Download profile",
      detail: "CDN-heavy traffic — Download profile prioritizes game assets",
      priority: "medium",
      action: { type: "traffic-profile", value: "download" },
    });
  }

  if (!routeAnalysis?.regionRanking?.length) {
    recs.push({
      source: "heuristic",
      title: "Run route probe",
      detail: "No datacenter ranking yet — probe to pick best internet paths",
      priority: "medium",
      action: { type: "route-probe" },
    });
  }

  for (const a of anomalies) {
    recs.push({
      source: "heuristic",
      title: a.message,
      detail: a.action,
      priority: a.severity,
    });
  }

  return { phase, anomalies, recommendations: recs, learning };
}

export function generateHeuristicInsights(snapshot, routeAnalysis = null, trafficProfile = "balanced", enforcementConfig = {}) {
  return heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig);
}

async function llmChat(messages) {
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.2,
      messages,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function classifyUnknownHosts(hosts) {
  if (!hosts.length || !AI_ENABLED) return [];

  const needLlm = hosts.filter((h) => !classificationCache[h.hostname]);
  if (!needLlm.length) {
    return hosts.map((h) => ({ ...h, ...classificationCache[h.hostname], source: "cache" }));
  }

  const prompt = `Classify these Xbox/gaming network hostnames for QoS routing.
Return JSON array only: [{"hostname":"...","roleId":"...","role":"...","tier":"critical|high|normal|low","detail":"..."}]
roleId examples: matchmaking, game-assets, telemetry, xbox-live, game-server, notifications, cdn, unknown
Hosts: ${JSON.stringify(needLlm.map((h) => h.hostname))}`;

  const raw = await llmChat([
    { role: "system", content: "You classify gaming network hostnames. Reply with valid JSON only." },
    { role: "user", content: prompt },
  ]);

  let parsed = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    return [];
  }

  for (const row of parsed) {
    if (row.hostname) {
      classificationCache[row.hostname.toLowerCase()] = {
        roleId: row.roleId || "unknown",
        role: row.role || "Unknown",
        tier: row.tier || "normal",
        detail: row.detail || "AI-classified",
      };
    }
  }
  saveCache();

  return hosts.map((h) => ({
    ...h,
    ...(classificationCache[h.hostname] || {}),
    source: classificationCache[h.hostname] ? "ai" : "unknown",
  }));
}

async function llmSessionSummary(snapshot, routeAnalysis, heuristics) {
  if (!AI_ENABLED) return null;

  const context = {
    xbox: snapshot?.xbox,
    trafficProfile: snapshot?.trafficProfile,
    phase: heuristics.phase,
    anomalies: heuristics.anomalies,
    topDestinations: (snapshot?.destinations || []).slice(0, 6).map((d) => ({
      host: d.hostname,
      role: d.role,
      latencyMs: d.latencyMs,
      routeQuality: d.routePathQuality,
    })),
    bestRegion: routeAnalysis?.bestRegion?.region,
    regionRanking: (routeAnalysis?.regionRanking || []).slice(0, 4),
    enforcement: routeAnalysis?.enforcement?.stats,
  };

  return llmChat([
    {
      role: "system",
      content:
        "You are a concise home-network gaming advisor for Xbox on Firewalla. Give 2-4 short bullet points: what is happening, any problems, and one clear action. Plain text, no markdown headers.",
    },
    { role: "user", content: `Analyze this gaming session data:\n${JSON.stringify(context, null, 2)}` },
  ]);
}

export async function generateInsights(snapshot, routeAnalysis = null, trafficProfile = "balanced", enforcementConfig = {}) {
  const heuristics = heuristicRecommendations(snapshot, routeAnalysis, trafficProfile, enforcementConfig);
  const unknowns = unknownHosts(snapshot);
  let aiClassifications = [];
  let summary = null;
  let llmError = null;

  if (AI_ENABLED && unknowns.length) {
    try {
      aiClassifications = await classifyUnknownHosts(unknowns);
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
    }
  }

  if (AI_ENABLED) {
    try {
      summary = await llmSessionSummary(snapshot, routeAnalysis, heuristics);
    } catch (err) {
      llmError = llmError || (err instanceof Error ? err.message : String(err));
    }
  }

  if (!summary && heuristics.recommendations.length) {
    summary = heuristics.recommendations
      .filter((r) => r.priority !== "info")
      .slice(0, 3)
      .map((r) => `• ${r.title}: ${r.detail}`)
      .join("\n");
  }

  return {
    timestamp: new Date().toISOString(),
    ai: aiStatus(),
    sessionPhase: heuristics.phase,
    anomalies: heuristics.anomalies,
    learning: heuristics.learning,
    recommendations: heuristics.recommendations,
    unknownClassifications: aiClassifications,
    roleRuleSuggestions: suggestRoleRules(),
    summary,
    llmError,
  };
}

export function applyAiClassifications(snapshot, classifications) {
  if (!classifications?.length) return snapshot;
  const byHost = new Map(classifications.map((c) => [c.hostname.toLowerCase(), c]));
  const merge = (item) => {
    const host = (item.hostname || item.label || "").toLowerCase();
    const ai = byHost.get(host);
    if (!ai || item.roleId !== "unknown") return item;
    return {
      ...item,
      roleId: ai.roleId,
      role: ai.role,
      tier: ai.tier,
      tierLabel: ai.tier,
      detail: `${ai.detail} (AI)`,
      aiClassified: true,
    };
  };
  return {
    ...snapshot,
    destinations: (snapshot.destinations || []).map(merge),
    connections: {
      ...snapshot.connections,
      items: (snapshot.connections?.items || []).map(merge),
    },
  };
}

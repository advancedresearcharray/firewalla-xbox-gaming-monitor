import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  enrichSnapshot,
  getProfiles,
  ipsForQos,
  applySuggestedRules,
} from "./lib/roles.mjs";
import {
  buildRouteTargets,
  buildRouteEnforcement,
  loadRouteProbesConfig,
  mergeRouteAnalysis,
} from "./lib/routes.mjs";
import {
  advisorStatus,
  applyPatternClassifications,
  detectSessionPhase,
  generateHeuristicInsights,
  generateInsights,
} from "./lib/ai-advisor.mjs";
import {
  getAdaptiveThresholds,
  initLearningStorage,
  recordSnapshot,
  recordSessionEvent,
} from "./lib/ai-learning.mjs";
import {
  loadPolicy,
  mergePolicy,
  policySummary,
  getCompetitiveDefaults,
  loadTrafficProfile,
  saveTrafficProfile,
} from "./lib/policy.mjs";
import {
  buildMtuTargets,
  mergeNetworkHealth,
  networkHealthSummary,
} from "./lib/network-health.mjs";
import {
  buildProcessorTelemetry,
  encodeRemotePayload,
} from "./lib/processor-tune.mjs";
import {
  createProcessorWire,
  decodeProcessorWire,
  wireStatsSummary,
} from "./lib/processor-wire.mjs";
import { createFirewallaClient, scriptBasename } from "./lib/firewalla-client.mjs";
import {
  memoryPressureTier,
  snapshotArgsForPressure,
} from "./lib/memory-pressure.mjs";
import { compressionEnabled, compressionHealth } from "./lib/array-compression-client.mjs";
import {
  detectGamingQosMode,
  ensureDynamicBandwidth,
  ensureStaticBandwidthCaps,
  netbotQosEnabled,
  removeBandwidthCaps,
  resolveXboxMac,
} from "./lib/qos-netbot.mjs";
import {
  analyzeSecurityTelemetry,
  shouldActivateGuard,
  shouldRelaxGuard,
  markGuardActive,
  guardActionCooldownReady,
  getSecurityState,
} from "./lib/security-telemetry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const routeConfig = loadRouteProbesConfig();

const PORT = Number(process.env.PORT || 9377);
const BASE_POLL_MS = Number(process.env.POLL_MS || 2500);
const FIREWALLA_CORES = Number(process.env.FIREWALLA_CORES || 4);
const ROUTE_PROBE_MS = (routeConfig.probeIntervalSec || 300) * 1000;
const FIREWALLA_API_URL = process.env.FIREWALLA_API_URL || "";
const FIREWALLA_API_TOKEN = process.env.FIREWALLA_API_TOKEN || "";
if (!FIREWALLA_API_URL) {
  console.error("FIREWALLA_API_URL is required — configure array-firewalla-api on the LAN");
  process.exit(1);
}
if (!FIREWALLA_API_TOKEN) {
  console.error("FIREWALLA_API_TOKEN is required — set in /etc/default/xbox-traffic-monitor");
  process.exit(1);
}
const firewallaClient = createFirewallaClient(FIREWALLA_API_URL, FIREWALLA_API_TOKEN);
const REMOTE_SCRIPT =
  process.env.REMOTE_SCRIPT || "/home/pi/gaming-tools/gaming-snapshot.sh";
const REMOTE_QOS =
  process.env.REMOTE_QOS || "/home/pi/gaming-tools/gaming-role-qos.sh";
const REMOTE_ROUTE =
  process.env.REMOTE_ROUTE || "/home/pi/gaming-tools/gaming-route-probe.sh";
const REMOTE_ENFORCE =
  process.env.REMOTE_ENFORCE || "/home/pi/gaming-tools/gaming-route-enforce.sh";
const REMOTE_BANDWIDTH =
  process.env.REMOTE_BANDWIDTH || "/home/pi/gaming-tools/gaming-bandwidth-qos.sh";
const REMOTE_DNS =
  process.env.REMOTE_DNS || "/home/pi/gaming-tools/gaming-dns-policy.sh";
const REMOTE_BUFFER =
  process.env.REMOTE_BUFFER || "/home/pi/gaming-tools/gaming-buffer-tune.sh";
const REMOTE_NAT =
  process.env.REMOTE_NAT || "/home/pi/gaming-tools/gaming-nat-check.sh";
const REMOTE_MTU =
  process.env.REMOTE_MTU || "/home/pi/gaming-tools/gaming-mtu-probe.sh";
const REMOTE_OFFLOAD =
  process.env.REMOTE_OFFLOAD ||
  "/home/pi/gaming-tools/gaming-offload-audit.sh";
const REMOTE_PROCESSOR_TUNE =
  process.env.REMOTE_PROCESSOR_TUNE ||
  "/home/pi/gaming-tools/gaming-processor-tune.sh";
const REMOTE_FIREWALLA_TUNE =
  process.env.REMOTE_FIREWALLA_TUNE ||
  "/home/pi/gaming-tools/gaming-firewalla-tune.sh";
const REMOTE_FLOOD_GUARD =
  process.env.REMOTE_FLOOD_GUARD ||
  "/home/pi/gaming-tools/gaming-flood-guard.sh";
const REMOTE_MOCA_TUNE =
  process.env.REMOTE_MOCA_TUNE ||
  "/home/pi/gaming-tools/gaming-moca-tune.sh";
const MOCA_PING_MS = Number(process.env.MOCA_PING_MS || 120000);
const ACCESS_PATH =
  process.env.ACCESS_PATH || "ScreenBeam MoCA (Xbox-dedicated)";
const FLOOD_GUARD_MODE = (process.env.FLOOD_GUARD_MODE || "always").toLowerCase();
const floodGuardAlwaysOn = FLOOD_GUARD_MODE === "always";
const XBOX_IP = process.env.XBOX_IP || "";
const NETWORK_HEALTH_MS = Number(process.env.NETWORK_HEALTH_MS || 900000);

let rawSnapshot = null;
let lastRouteData = null;
let lastRouteEnforcement = null;
let lastRouteProbe = 0;
let routeProbing = false;
let routeError = null;
let routeEnforceError = null;
let routeEnforceStatus = null;
let routeEnforcementEnabled = routeConfig.enforcement?.enabledByDefault !== false;
let routeProbePromise = null;
let trafficProfile = loadTrafficProfile(getProfiles());
let qosStatus = null;
let bandwidthStatus = null;
let dnsStatus = null;
let bufferStatus = null;
let lastQosSync = 0;
let lastError = null;
let polling = false;
let lastAiInsights = null;
let aiInsightsRunning = false;
let lastEnforcementSync = 0;
let lastNetworkHealth = null;
let lastNetworkHealthProbe = 0;
let networkHealthProbing = false;
let networkHealthError = null;
let networkHealthPromise = null;
let previousNatType = null;
let effectivePollMs = BASE_POLL_MS;
let pollTimer = null;
let processorTelemetry = null;
let lastProcessorSample = 0;
let processorTuneStatus = null;
let processorTuneError = null;
let lastWireStats = null;
let lastProcessorWire = null;
let lastAdvisorPhase = null;
let lastAdvisorProcessorHealth = null;
let lastUnknownHostCount = 0;
let lastAutoAnalysisAt = 0;
const AUTO_ANALYSIS_COOLDOWN_MS = 15000;
let lastSecurityTelemetry = null;
let floodGuardStatus = null;
let floodGuardError = null;
let lastMocaProbe = null;
let lastMocaTrack = null;
let lastMocaProbeAt = 0;
let mocaTuneStatus = null;
let mocaTuneError = null;

function buildAdvisorContext() {
  return {
    processor: processorTelemetry,
    networkHealth: lastNetworkHealth,
    trafficProfile,
  };
}

function maybeRunAutoAnalysis(enriched, routeAnalysis) {
  if (!enriched || aiInsightsRunning) return;
  const now = Date.now();
  if (now - lastAutoAnalysisAt < AUTO_ANALYSIS_COOLDOWN_MS) return;

  const phase = detectSessionPhase(enriched);
  const procHealth = processorTelemetry?.health?.status;
  const natDegraded = lastNetworkHealth?.nat?.degraded;
  const unknownHeavy = (enriched.destinations || []).filter(
    (d) => d.roleId === "unknown" && (d.bytes || 0) > 50000,
  ).length;

  const events = [];
  if (lastAdvisorPhase && lastAdvisorPhase !== phase.phase) events.push("phase-change");
  if (procHealth === "stressed" && lastAdvisorProcessorHealth !== "stressed") {
    events.push("processor-stressed");
  }
  if (natDegraded) events.push("nat-degraded");
  if (unknownHeavy > lastUnknownHostCount) events.push("unknown-host");

  lastAdvisorPhase = phase.phase;
  lastAdvisorProcessorHealth = procHealth;
  lastUnknownHostCount = unknownHeavy;

  if (!events.length) return;

  lastAutoAnalysisAt = now;
  let data = mergeNetworkHealth(enriched, lastNetworkHealth);
  if (routeAnalysis) {
    data = { ...data, routeAnalysis };
  }
  lastAiInsights = generateInsights(
    data,
    data.routeAnalysis,
    trafficProfile,
    { ...routeConfig.enforcement, ...adaptiveThresholds() },
    buildAdvisorContext(),
  );
  for (const ev of events) recordSessionEvent(`auto-${ev}`, { phase: phase.phase });
}

function adaptiveThresholds() {
  return getAdaptiveThresholds(routeConfig);
}

function buildEnforcement(routeData) {
  const thresholds = adaptiveThresholds();
  return buildRouteEnforcement(routeData, routeConfig, thresholds);
}

function getLatest() {
  if (!rawSnapshot) return null;
  let data = enrichSnapshot(rawSnapshot, trafficProfile);
  const thresholds = adaptiveThresholds();
  if (lastRouteData) {
    const enforcement = lastRouteEnforcement || buildEnforcement(lastRouteData);
    data = mergeRouteAnalysis(data, lastRouteData, enforcement);
    if (data.routeAnalysis) {
      data.routeAnalysis.enforcementActive = routeEnforcementEnabled;
      data.routeAnalysis.enforcementStatus = routeEnforceStatus;
    }
  }
  if (lastAiInsights?.patternClassifications?.length) {
    data = applyPatternClassifications(data, lastAiInsights.patternClassifications);
  }
  data = mergeNetworkHealth(data, lastNetworkHealth);
  if (lastNetworkHealth) {
    data.networkHealthSummary = networkHealthSummary(lastNetworkHealth);
  }
  const heuristics = generateHeuristicInsights(
    data,
    data.routeAnalysis,
    trafficProfile,
    { ...routeConfig.enforcement, ...thresholds },
    buildAdvisorContext(),
  );
  data.aiInsights = {
    ...heuristics,
    status: advisorStatus(),
    lastFullAnalysis: lastAiInsights?.timestamp || null,
    summary: lastAiInsights?.summary || null,
    adaptiveThresholds: thresholds,
  };
  if (processorTelemetry) {
    data.processor = processorTelemetry;
  }
  if (lastProcessorWire) {
    data.processorWire = {
      compressionRatio: lastProcessorWire.compressionRatio,
      rawBytes: lastProcessorWire.rawBytes,
      compressedBytes: lastProcessorWire.compressedBytes,
      preservation: lastProcessorWire.preservation,
    };
  }
  if (lastRouteData && data.routeAnalysis) {
    data.routeAnalysis.folding = processorTelemetry?.folding || null;
  }
  if (lastSecurityTelemetry) {
    data.securityTelemetry = lastSecurityTelemetry;
  }
  if (lastMocaProbe) {
    data.mocaPath = lastMocaProbe;
  }
  if (lastMocaTrack) {
    data.mocaTrack = lastMocaTrack;
  }
  return data;
}

async function applyRouteEnforcement(routeData) {
  lastRouteEnforcement = buildEnforcement(routeData);
  if (!routeEnforcementEnabled) {
    routeEnforceStatus = await runRemoteScript(REMOTE_ENFORCE, ["off"], { sudo: true });
    routeEnforceError = null;
    return { enabled: false, ...lastRouteEnforcement };
  }
  routeEnforceStatus = await runRemoteScript(
    REMOTE_ENFORCE,
    ["sync", "@payload"],
    { sudo: true, payload: lastRouteEnforcement },
  );
  routeEnforceError = null;
  lastEnforcementSync = Date.now();
  return { enabled: true, status: routeEnforceStatus, ...lastRouteEnforcement };
}

async function routeProbeOnce() {
  if (routeProbePromise) return routeProbePromise;
  if (!rawSnapshot) return null;

  routeProbePromise = (async () => {
    routeProbing = true;
    try {
      const enriched = enrichSnapshot(rawSnapshot, trafficProfile);
      const targets = buildRouteTargets(enriched, routeConfig);
      const out = await runRemoteScript(REMOTE_ROUTE, ["@payload"], {
        payload: { targets },
      });
      lastRouteData = JSON.parse(out);
      lastRouteProbe = Date.now();
      routeError = null;
      await sampleProcessorLoad();
      if (routeEnforcementEnabled) {
        try {
          await applyRouteEnforcement(lastRouteData);
        } catch (err) {
          routeEnforceError = err instanceof Error ? err.message : String(err);
        }
      }
      return lastRouteData;
    } catch (err) {
      routeError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      routeProbing = false;
      routeProbePromise = null;
    }
  })();

  return routeProbePromise;
}

function maybeScheduleRouteProbe() {
  if (routeProbing || !rawSnapshot) return;
  if (processorTelemetry?.deferHeavyProbes) return;
  if (Date.now() - lastRouteProbe < ROUTE_PROBE_MS) return;
  routeProbeOnce().catch(() => {});
}

async function networkHealthProbeOnce() {
  if (networkHealthPromise) return networkHealthPromise;
  if (!rawSnapshot) return null;

  networkHealthPromise = (async () => {
    networkHealthProbing = true;
    try {
      const natOut = await runRemoteScript(REMOTE_NAT, []);
      const nat = JSON.parse(natOut);
      const natType = nat.natType || "unknown";
      if (previousNatType && previousNatType !== natType) {
        nat.changedFrom = previousNatType;
        nat.degraded =
          ["open", "moderate", "strict"].indexOf(natType) >
          ["open", "moderate", "strict"].indexOf(previousNatType);
      }
      previousNatType = natType;

      const mtuInput = buildMtuTargets(enrichSnapshot(rawSnapshot, trafficProfile));
      const mtuOut = await runRemoteScript(REMOTE_MTU, ["@payload"], {
        payload: mtuInput,
      });
      const mtu = JSON.parse(mtuOut);

      const offloadOut = await runRemoteScript(REMOTE_OFFLOAD, []);
      const offload = JSON.parse(offloadOut);

      lastNetworkHealth = {
        probedAt: Date.now(),
        nat,
        mtu,
        offload,
      };
      lastNetworkHealthProbe = Date.now();
      networkHealthError = null;
      return lastNetworkHealth;
    } catch (err) {
      networkHealthError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      networkHealthProbing = false;
      networkHealthPromise = null;
    }
  })();

  return networkHealthPromise;
}

function maybeScheduleNetworkHealth() {
  if (networkHealthProbing || !rawSnapshot) return;
  if (processorTelemetry?.deferHeavyProbes) return;
  if (Date.now() - lastNetworkHealthProbe < NETWORK_HEALTH_MS) return;
  networkHealthProbeOnce().catch(() => {});
}

async function sampleProcessorLoad() {
  if (!firewallaClient) return;
  try {
    const out = await runSystemProbe();
    const lines = out.split("\n");
    const loadRaw = lines[0] || "";
    const memLine = lines.find((l) => l.startsWith("MemAvailable:")) || "";
    const memKb = Number((memLine.match(/(\d+)/) || [])[1]);
    const memAvailableMb = Number.isFinite(memKb) ? Math.round(memKb / 1024) : null;
    processorTelemetry = buildProcessorTelemetry({
      loadRaw,
      memAvailableMb,
      basePollMs: BASE_POLL_MS,
      cores: FIREWALLA_CORES,
      routeData: lastRouteData,
      snapshot: rawSnapshot ? enrichSnapshot(rawSnapshot, trafficProfile) : null,
      wireStats: lastWireStats,
    });
    effectivePollMs = processorTelemetry.pollMs;
    lastProcessorSample = Date.now();
  } catch (err) {
    processorTelemetry = {
      ...processorTelemetry,
      health: { status: "unknown", detail: err instanceof Error ? err.message : String(err) },
      pollMs: BASE_POLL_MS,
      basePollMs: BASE_POLL_MS,
      sampledAt: Date.now(),
    };
    effectivePollMs = BASE_POLL_MS;
  }
}

async function applyMocaTune() {
  mocaTuneStatus = await runRemoteScript(REMOTE_MOCA_TUNE, ["apply"], { sudo: true });
  mocaTuneError = null;
  return mocaTuneStatus;
}

async function probeMocaPath() {
  if (Date.now() - lastMocaProbeAt < MOCA_PING_MS) return lastMocaTrack || lastMocaProbe;
  try {
    const out = await runRemoteScript(REMOTE_MOCA_TUNE, ["track"], { sudo: false });
    lastMocaTrack = JSON.parse(out);
    lastMocaProbe = lastMocaTrack?.xboxPath || lastMocaTrack?.path || null;
    if (lastMocaProbe && !lastMocaProbe.path) {
      lastMocaProbe = {
        ok: true,
        host: lastMocaTrack.xboxPath?.ip,
        avgMs: lastMocaTrack.path?.avgMs ?? lastMocaTrack.xboxPath?.avgMs,
        jitterMs: lastMocaTrack.path?.jitterMs ?? lastMocaTrack.xboxPath?.jitterMs,
        minMs: lastMocaTrack.xboxPath?.minMs,
        maxMs: lastMocaTrack.xboxPath?.maxMs,
        path: "firewalla-to-xbox",
      };
    }
    lastMocaProbeAt = Date.now();
    mocaTuneError = null;
  } catch (err) {
    mocaTuneError = err instanceof Error ? err.message : String(err);
  }
  return lastMocaTrack || lastMocaProbe;
}

async function applyFloodGuard(mode) {
  const cmd = mode === "defend" ? "defend" : "relax";
  floodGuardStatus = await runRemoteScript(REMOTE_FLOOD_GUARD, [cmd], { sudo: true });
  markGuardActive(cmd === "defend");
  floodGuardError = null;
  return floodGuardStatus;
}

async function maybeAdjustSecurityGuard(snapshot) {
  lastSecurityTelemetry = analyzeSecurityTelemetry(snapshot);
  if (!guardActionCooldownReady()) return lastSecurityTelemetry;

  try {
    if (shouldActivateGuard(lastSecurityTelemetry)) {
      if (!getSecurityState().guardActive) {
        await applyFloodGuard("defend");
        console.warn("[security] Flood guard ON — inbound attack pattern detected");
      }
    } else if (!floodGuardAlwaysOn && shouldRelaxGuard(lastSecurityTelemetry)) {
      await applyFloodGuard("relax");
      console.log("[security] Flood guard OFF — traffic normalized");
    }
  } catch (err) {
    floodGuardError = err instanceof Error ? err.message : String(err);
  }
  lastSecurityTelemetry.guardActive = getSecurityState().guardActive;
  lastSecurityTelemetry.floodGuardStatus = floodGuardStatus;
  lastSecurityTelemetry.floodGuardError = floodGuardError;
  return lastSecurityTelemetry;
}

async function applyProcessorTune() {
  const parts = [];
  try {
    parts.push(await runRemoteScript(REMOTE_PROCESSOR_TUNE, ["apply"]));
    processorTuneError = null;
  } catch (err) {
    processorTuneError = err instanceof Error ? err.message : String(err);
  }
  try {
    parts.push(await runRemoteScript(REMOTE_FIREWALLA_TUNE, ["apply"]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    processorTuneError = processorTuneError ? `${processorTuneError}; ${msg}` : msg;
  }
  processorTuneStatus = parts.join("\n");
  await sampleProcessorLoad();
  return { status: processorTuneStatus, error: processorTuneError, processor: processorTelemetry };
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function runRemoteScript(scriptPath, args = [], { sudo = false, payload = null } = {}) {
  return firewallaClient.runScript(scriptBasename(scriptPath), args, { sudo, payload });
}

async function runSystemProbe() {
  return firewallaClient.systemProbe();
}

function fetchSnapshot() {
  const tier =
    processorTelemetry?.memoryPressure ??
    memoryPressureTier(processorTelemetry?.memAvailableMb);
  const args = snapshotArgsForPressure(tier, XBOX_IP);
  return runRemoteScript(REMOTE_SCRIPT, args);
}

async function netbotCall(mtype, data, target = null) {
  return firewallaClient.netbot(mtype, data, target);
}

async function xboxMacForQos() {
  const fromSnapshot = rawSnapshot?.xbox?.mac;
  if (fromSnapshot) return fromSnapshot;
  return resolveXboxMac(netbotCall, XBOX_IP);
}

async function applyBandwidthPolicy(profile) {
  const policy = loadPolicy();
  const mac = await xboxMacForQos();
  const useNetbot = netbotQosEnabled() && mac;

  if (profile !== "competitive") {
    if (useNetbot) {
      try {
        const result = await removeBandwidthCaps(netbotCall, mac);
        bandwidthStatus = JSON.stringify(result);
        await runRemoteScript(REMOTE_BANDWIDTH, ["off"], { sudo: true }).catch(() => "");
        return { mode: "off", ...result, status: bandwidthStatus };
      } catch (err) {
        console.warn("[qos] netbot off failed, falling back to script:", err.message);
      }
    }
    bandwidthStatus = await runRemoteScript(REMOTE_BANDWIDTH, ["off"], { sudo: true });
    return { mode: "off", status: bandwidthStatus };
  }

  if (policy.bandwidth.mode === "static") {
    const up = Number(policy.bandwidth.uploadMbps) || 500;
    const down = Number(policy.bandwidth.downloadMbps) || 500;
    if (useNetbot) {
      try {
        const result = await ensureStaticBandwidthCaps(netbotCall, mac, up, down);
        bandwidthStatus = JSON.stringify(result);
        await runRemoteScript(REMOTE_BANDWIDTH, ["off"], { sudo: true }).catch(() => "");
        return { mode: "static", uploadMbps: up, downloadMbps: down, ...result, status: bandwidthStatus };
      } catch (err) {
        console.warn("[qos] netbot static failed, falling back to tc script:", err.message);
      }
    }
    bandwidthStatus = await runRemoteScript(
      REMOTE_BANDWIDTH,
      ["static", String(up), String(down)],
      { sudo: true },
    );
    return { mode: "static", uploadMbps: up, downloadMbps: down, status: bandwidthStatus };
  }

  if (useNetbot) {
    try {
      const result = await ensureDynamicBandwidth(netbotCall, mac);
      bandwidthStatus = JSON.stringify(result);
      await runRemoteScript(REMOTE_BANDWIDTH, ["dynamic"], { sudo: true }).catch(() => "");
      return { mode: "dynamic", ...result, status: bandwidthStatus };
    } catch (err) {
      console.warn("[qos] netbot dynamic failed, falling back to script:", err.message);
    }
  }
  bandwidthStatus = await runRemoteScript(REMOTE_BANDWIDTH, ["dynamic"], { sudo: true });
  return { mode: "dynamic", status: bandwidthStatus };
}

async function applyDnsPolicy(profile) {
  const policy = loadPolicy();
  if (profile !== "competitive" || !policy.dns.enabled) {
    dnsStatus = await runRemoteScript(REMOTE_DNS, ["off"], { sudo: true });
    return { enabled: false, scope: "xbox-only", status: dnsStatus };
  }
  const primary = policy.dns.primary || "1.1.1.1";
  const secondary = policy.dns.secondary || "";
  const dnsArgs = secondary ? ["on", primary, secondary] : ["on", primary];
  dnsStatus = await runRemoteScript(REMOTE_DNS, dnsArgs, { sudo: true });
  return {
    enabled: true,
    scope: "xbox-only",
    primary,
    secondary: secondary || null,
    status: dnsStatus,
  };
}

async function applyBufferPolicy(profile) {
  const policy = loadPolicy();
  if (profile !== "competitive") {
    bufferStatus = await runRemoteScript(REMOTE_BUFFER, ["off"], { sudo: true });
    return { mode: "off", status: bufferStatus };
  }
  const mode = policy.buffers?.mode || "large";
  bufferStatus = await runRemoteScript(REMOTE_BUFFER, ["apply", mode], { sudo: true });
  return { mode, status: bufferStatus };
}

async function applyCompetitivePolicies(profile) {
  const qos = await applyQosProfile(profile);
  const bandwidth = await applyBandwidthPolicy(profile);
  const buffers = await applyBufferPolicy(profile);
  const dns = await applyDnsPolicy(profile);
  let moca = null;
  if (profile === "competitive") {
    try {
      moca = await applyMocaTune();
    } catch (err) {
      mocaTuneError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ...qos, bandwidth, buffers, dns, moca: mocaTuneStatus, mocaError: mocaTuneError };
}

async function applyQosProfile(profile) {
  if (profile === "balanced") {
    qosStatus = await runRemoteScript(REMOTE_QOS, ["off"], { sudo: true });
    return { profile, qos: qosStatus };
  }
  const ips = ipsForQos(rawSnapshot, profile);
  qosStatus = await runRemoteScript(
    REMOTE_QOS,
    ["sync", profile, "@payload"],
    { sudo: true, payload: ips },
  );
  return { profile, ipCount: ips.length, qos: qosStatus };
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    if (Date.now() - lastProcessorSample > 15000) {
      await sampleProcessorLoad();
    }
    const out = await fetchSnapshot();
    const decoded = decodeProcessorWire(out);
    rawSnapshot = decoded.snapshot;
    lastWireStats = wireStatsSummary(
      { ...decoded.stats, mode: decoded.mode },
      decoded,
    );
    lastProcessorWire = createProcessorWire(rawSnapshot, lastRouteData);
    lastError = null;
    if (processorTelemetry) {
      if (rawSnapshot?.preabstract) {
        processorTelemetry = {
          ...processorTelemetry,
          preabstract: rawSnapshot.preabstract,
        };
      }
      processorTelemetry = buildProcessorTelemetry({
        loadRaw: processorTelemetry.load?.raw || "",
        memAvailableMb: processorTelemetry.memAvailableMb,
        basePollMs: BASE_POLL_MS,
        cores: FIREWALLA_CORES,
        routeData: lastRouteData,
        snapshot: enrichSnapshot(rawSnapshot, trafficProfile),
        wireStats: lastWireStats,
      });
      lastProcessorWire = createProcessorWire(rawSnapshot, lastRouteData);
    }
    const enriched = enrichSnapshot(rawSnapshot, trafficProfile);
    let routeAnalysis = null;
    if (lastRouteData) {
      const enforcement = lastRouteEnforcement || buildEnforcement(lastRouteData);
      const merged = mergeRouteAnalysis(enriched, lastRouteData, enforcement);
      routeAnalysis = merged.routeAnalysis;
      routeAnalysis.enforcementActive = routeEnforcementEnabled;
    }
    const phase = detectSessionPhase(enriched);
    recordSnapshot(enriched, routeAnalysis, {
      processor: processorTelemetry,
      networkHealth: lastNetworkHealth,
      trafficProfile,
      sessionPhase: phase,
    });
    maybeRunAutoAnalysis(enriched, routeAnalysis);
    await maybeAdjustSecurityGuard(rawSnapshot);
    probeMocaPath().catch(() => {});
    if (trafficProfile !== "balanced" && Date.now() - lastQosSync > 30000) {
      try {
        await applyCompetitivePolicies(trafficProfile);
        lastQosSync = Date.now();
      } catch (err) {
        lastError = `QoS sync: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (
      routeEnforcementEnabled &&
      lastRouteData &&
      Date.now() - lastEnforcementSync > 300000
    ) {
      try {
        await applyRouteEnforcement(lastRouteData);
        lastEnforcementSync = Date.now();
      } catch (err) {
        routeEnforceError = err instanceof Error ? err.message : String(err);
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    polling = false;
    maybeScheduleRouteProbe();
    maybeScheduleNetworkHealth();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/health") {
    let compression = { enabled: compressionEnabled(), ok: false };
    if (compression.enabled) {
      try {
        compression = { enabled: true, ok: true, ...(await compressionHealth()) };
      } catch (err) {
        compression = {
          enabled: true,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    sendJson(res, 200, {
      ok: true,
      firewallaApi: FIREWALLA_API_URL,
      transport: "api",
      xboxIp: XBOX_IP,
      trafficProfile,
      policy: loadPolicy(),
      policySummary: policySummary(),
      hasData: Boolean(rawSnapshot),
      lastError,
      processor: processorTelemetry,
      effectivePollMs,
      compression,
      security: lastSecurityTelemetry,
      floodGuard: {
        active: getSecurityState().guardActive,
        mode: FLOOD_GUARD_MODE,
        alwaysOn: floodGuardAlwaysOn,
        status: floodGuardStatus,
        error: floodGuardError,
      },
      mocaPath: lastMocaProbe,
      mocaTrack: lastMocaTrack,
      accessPath: ACCESS_PATH,
    });
    return;
  }

  if (url.pathname === "/api/processor" && req.method === "GET") {
    sendJson(res, 200, {
      processor: processorTelemetry,
      effectivePollMs,
      basePollMs: BASE_POLL_MS,
      tuneStatus: processorTuneStatus,
      tuneError: processorTuneError,
    });
    return;
  }

  if (url.pathname === "/api/processor-tune" && req.method === "POST") {
    try {
      const result = await applyProcessorTune();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/api/network-health" && req.method === "GET") {
    sendJson(res, 200, {
      health: lastNetworkHealth,
      summary: networkHealthSummary(lastNetworkHealth),
      probing: networkHealthProbing,
      error: networkHealthError,
      lastProbe: lastNetworkHealthProbe || null,
    });
    return;
  }

  if (url.pathname === "/api/network-health" && req.method === "POST") {
    try {
      const data = await networkHealthProbeOnce();
      if (!data) {
        sendJson(res, 503, { error: "No snapshot yet — wait for first poll" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        health: data,
        summary: networkHealthSummary(data),
        data: getLatest(),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/competitive-policy" && req.method === "GET") {
    sendJson(res, 200, {
      activeProfile: trafficProfile,
      policy: loadPolicy(),
      defaults: getCompetitiveDefaults(),
      summary: policySummary(),
      bandwidthStatus,
      bufferStatus,
      dnsStatus,
      security: lastSecurityTelemetry,
      floodGuard: {
        active: getSecurityState().guardActive,
        mode: FLOOD_GUARD_MODE,
        alwaysOn: floodGuardAlwaysOn,
        status: floodGuardStatus,
        error: floodGuardError,
      },
    });
    return;
  }

  if (url.pathname === "/api/competitive-policy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const policy = mergePolicy(body);
      let applied = null;
      if (trafficProfile === "competitive") {
        applied = {
          bandwidth: await applyBandwidthPolicy("competitive"),
          buffers: await applyBufferPolicy("competitive"),
          dns: await applyDnsPolicy("competitive"),
        };
        lastQosSync = Date.now();
      }
      sendJson(res, 200, {
        ok: true,
        policy,
        summary: policySummary(policy),
        applied,
        data: getLatest(),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/security-telemetry" && req.method === "GET") {
    sendJson(res, 200, {
      telemetry: lastSecurityTelemetry,
      state: getSecurityState(),
      floodGuard: {
        active: getSecurityState().guardActive,
        mode: FLOOD_GUARD_MODE,
        alwaysOn: floodGuardAlwaysOn,
        status: floodGuardStatus,
        error: floodGuardError,
      },
    });
    return;
  }

  if (url.pathname === "/api/security-guard" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const mode = body.mode === "defend" ? "defend" : "relax";
      const status = await applyFloodGuard(mode);
      lastSecurityTelemetry = analyzeSecurityTelemetry(rawSnapshot);
      if (lastSecurityTelemetry) {
        lastSecurityTelemetry.guardActive = getSecurityState().guardActive;
        lastSecurityTelemetry.floodGuardStatus = status;
      }
      sendJson(res, 200, {
        ok: true,
        mode,
        status,
        telemetry: lastSecurityTelemetry,
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/profiles" && req.method === "GET") {
    sendJson(res, 200, { profiles: getProfiles(), active: trafficProfile });
    return;
  }

  if (url.pathname === "/api/traffic-policy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const profile = body.profile || "balanced";
      if (!getProfiles()[profile]) {
        sendJson(res, 400, { error: `Unknown profile: ${profile}` });
        return;
      }
      trafficProfile = profile;
      saveTrafficProfile(profile);
      const result = await applyCompetitivePolicies(profile);
      lastQosSync = Date.now();
      sendJson(res, 200, {
        ok: true,
        ...result,
        policy: loadPolicy(),
        policySummary: policySummary(),
        data: getLatest(),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/route-probe" && req.method === "POST") {
    try {
      const data = await routeProbeOnce();
      if (!data) {
        sendJson(res, 503, { error: "No snapshot yet — wait for first poll" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        routeAnalysis: data,
        routeEnforcement: lastRouteEnforcement,
        routeEnforcementEnabled,
        data: getLatest(),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/route-policy" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (typeof body.enabled === "boolean") {
        routeEnforcementEnabled = body.enabled;
      }
      if (!lastRouteData && routeEnforcementEnabled) {
        sendJson(res, 503, { error: "No route probe data yet — run probe first" });
        return;
      }
      const result = lastRouteData
        ? await applyRouteEnforcement(lastRouteData)
        : { enabled: false, blocked: [], stats: { blockedCount: 0 } };
      sendJson(res, 200, {
        ok: true,
        routeEnforcementEnabled,
        routeEnforcement: result,
        data: getLatest(),
      });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url.pathname === "/api/route-policy" && req.method === "GET") {
    sendJson(res, 200, {
      enabled: routeEnforcementEnabled,
      enforcement: lastRouteEnforcement,
      status: routeEnforceStatus,
      error: routeEnforceError,
    });
    return;
  }

  if (url.pathname === "/api/ai-insights" && req.method === "GET") {
    sendJson(res, 200, {
      status: advisorStatus(),
      insights: lastAiInsights,
      data: getLatest(),
      sessions: lastAiInsights?.learning?.sessions || null,
      outcomeStats: lastAiInsights?.learning?.outcomeStats || null,
    });
    return;
  }

  if (url.pathname === "/api/ai-insights" && req.method === "POST") {
    if (aiInsightsRunning) {
      sendJson(res, 429, { error: "AI analysis already in progress" });
      return;
    }
    const latest = getLatest();
    if (!latest) {
      sendJson(res, 503, { error: "No snapshot yet" });
      return;
    }
    aiInsightsRunning = true;
    try {
      lastAiInsights = generateInsights(
        latest,
        latest.routeAnalysis,
        trafficProfile,
        { ...routeConfig.enforcement, ...adaptiveThresholds() },
        buildAdvisorContext(),
      );
      sendJson(res, 200, { ok: true, insights: lastAiInsights, data: getLatest() });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      aiInsightsRunning = false;
    }
    return;
  }

  if (url.pathname === "/api/ai-rules" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const suggestions = body.rules || lastAiInsights?.roleRuleSuggestions || getLatest()?.aiInsights?.learning?.roleRuleSuggestions;
      if (!suggestions?.length) {
        sendJson(res, 400, { error: "No rule suggestions available — run AI analysis first" });
        return;
      }
      const result = applySuggestedRules(suggestions);
      sendJson(res, 200, { ok: true, ...result, data: getLatest() });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (url.pathname === "/api/snapshot") {
    const latest = getLatest();
    if (!latest && lastError) {
      sendJson(res, 503, { error: lastError });
      return;
    }
    sendJson(res, 200, {
      data: latest,
      trafficProfile,
      policy: loadPolicy(),
      policySummary: policySummary(),
      routeError,
      routeEnforceError,
      routeEnforcementEnabled,
      lastRouteProbe: lastRouteProbe || null,
      lastError,
      polledAt: latest?.timestamp ?? null,
    });
    return;
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const push = () => {
      res.write(
        `data: ${JSON.stringify({ data: getLatest(), lastError, trafficProfile, policy: loadPolicy(), policySummary: policySummary(), routeError, routeEnforceError, routeEnforcementEnabled, routeProbing, networkHealth: lastNetworkHealth, networkHealthSummary: networkHealthSummary(lastNetworkHealth), networkHealthError, networkHealthProbing, processor: processorTelemetry, effectivePollMs, security: lastSecurityTelemetry, floodGuard: { active: getSecurityState().guardActive, status: floodGuardStatus, error: floodGuardError }, mocaPath: lastMocaProbe, mocaTrack: lastMocaTrack, accessPath: ACCESS_PATH })}\n\n`,
      );
    };
    push();
    const timer = setInterval(push, effectivePollMs);
    req.on("close", () => clearInterval(timer));
    return;
  }

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR) || !existsSync(abs)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": contentType(abs),
    "Cache-Control": "no-store",
  });
  createReadStream(abs).pipe(res);
});

async function verifyFirewallaApi() {
  const health = await firewallaClient.health();
  if (!health.ok) {
    throw new Error("Firewalla API health check failed");
  }
  const bridge = health.netbotBridge?.ok ? "up" : "down";
  console.log(`Firewalla API OK at ${FIREWALLA_API_URL} (netbot bridge ${bridge})`);
  return health;
}

await verifyFirewallaApi();
await initLearningStorage();
await pollOnce();
if (floodGuardAlwaysOn) {
  try {
    await applyFloodGuard("defend");
    console.log("[security] Flood guard always-on — defend active");
  } catch (err) {
    floodGuardError = err instanceof Error ? err.message : String(err);
    console.warn("[security] Always-on flood guard failed:", floodGuardError);
  }
}
if (trafficProfile !== "balanced") {
  try {
    await applyCompetitivePolicies(trafficProfile);
    lastQosSync = Date.now();
  } catch (err) {
    lastError = `Profile restore: ${err instanceof Error ? err.message : String(err)}`;
  }
}
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollOnce();
    schedulePoll();
  }, effectivePollMs);
}

await sampleProcessorLoad();
schedulePoll();
routeProbeOnce().catch(() => {});
networkHealthProbeOnce().catch(() => {});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`xbox-traffic-monitor listening on http://0.0.0.0:${PORT}`);
  console.log(`  Firewalla API: ${FIREWALLA_API_URL}`);
  console.log(`  Xbox IP: ${XBOX_IP}`);
});

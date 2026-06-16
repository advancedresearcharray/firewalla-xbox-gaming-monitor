import { spawn } from "node:child_process";
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
  generateHeuristicInsights,
  generateInsights,
} from "./lib/ai-advisor.mjs";
import {
  getAdaptiveThresholds,
  recordSnapshot,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const routeConfig = loadRouteProbesConfig();

const PORT = Number(process.env.PORT || 9377);
const BASE_POLL_MS = Number(process.env.POLL_MS || 2500);
const FIREWALLA_CORES = Number(process.env.FIREWALLA_CORES || 4);
const ROUTE_PROBE_MS = (routeConfig.probeIntervalSec || 300) * 1000;
const FIREWALLA_HOST = process.env.FIREWALLA_HOST || "";
const FIREWALLA_USER = process.env.FIREWALLA_USER || "pi";
const FIREWALLA_SSH_KEY = process.env.FIREWALLA_SSH_KEY || "";
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
  return data;
}

async function applyRouteEnforcement(routeData) {
  lastRouteEnforcement = buildEnforcement(routeData);
  if (!routeEnforcementEnabled) {
    routeEnforceStatus = await sshRun(`sudo ${REMOTE_ENFORCE} off`);
    routeEnforceError = null;
    return { enabled: false, ...lastRouteEnforcement };
  }
  const tmp = `/tmp/xbox-route-enforce-${Date.now()}.json`;
  const encoded = encodeRemotePayload(lastRouteEnforcement);
  routeEnforceStatus = await sshRunWithPayload(
    lastRouteEnforcement,
    tmp,
    `sudo ${REMOTE_ENFORCE} sync ${tmp}`,
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
      const tmpIn = `/tmp/xbox-route-in-${Date.now()}.json`;
      const out = await sshRunWithPayload(
        { targets },
        tmpIn,
        `bash ${REMOTE_ROUTE} ${tmpIn}`,
      );
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
      const natOut = await sshRun(`bash ${REMOTE_NAT}`);
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
      const tmpIn = `/tmp/xbox-mtu-in-${Date.now()}.json`;
      const mtuOut = await sshRunWithPayload(
        mtuInput,
        tmpIn,
        `bash ${REMOTE_MTU} ${tmpIn}`,
      );
      const mtu = JSON.parse(mtuOut);

      const offloadOut = await sshRun(`bash ${REMOTE_OFFLOAD}`);
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
  if (!FIREWALLA_HOST) return;
  try {
    const out = await sshRun("cat /proc/loadavg; grep -m1 MemAvailable /proc/meminfo");
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

async function applyProcessorTune() {
  const parts = [];
  try {
    parts.push(await sshRun(`bash ${REMOTE_PROCESSOR_TUNE} apply`));
    processorTuneError = null;
  } catch (err) {
    processorTuneError = err instanceof Error ? err.message : String(err);
  }
  try {
    parts.push(await sshRun(`bash ${REMOTE_FIREWALLA_TUNE} apply`));
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

function sshArgs() {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
  ];
  if (FIREWALLA_SSH_KEY) args.push("-i", FIREWALLA_SSH_KEY);
  return args;
}

function sshRun(remoteCmd, stdin = null) {
  return new Promise((resolve, reject) => {
    const args = [
      ...sshArgs(),
      `${FIREWALLA_USER}@${FIREWALLA_HOST}`,
      remoteCmd,
    ];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `ssh exited ${code}`));
      else resolve(stdout.trim());
    });
    child.on("error", reject);
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

async function sshRunWithPayload(data, tmpPath, followCmd) {
  const encoded = encodeRemotePayload(data);
  const transport =
    encoded.payload.length > 12000 && encoded.shellWriteStdin
      ? encoded.shellWriteStdin(tmpPath)
      : { cmd: encoded.shellWrite(tmpPath), stdin: null };
  const remote = transport.stdin
    ? `cat | ${transport.cmd} && ${followCmd} && rm -f ${tmpPath}`
    : `${transport.cmd} && ${followCmd} && rm -f ${tmpPath}`;
  return sshRun(remote, transport.stdin);
}

function fetchSnapshot() {
  return sshRun(`bash ${REMOTE_SCRIPT} ${XBOX_IP} --wire`);
}

async function applyBandwidthPolicy(profile) {
  const policy = loadPolicy();
  if (profile !== "competitive") {
    bandwidthStatus = await sshRun(`sudo ${REMOTE_BANDWIDTH} off`);
    return { mode: "off", status: bandwidthStatus };
  }
  if (policy.bandwidth.mode === "static") {
    const up = Number(policy.bandwidth.uploadMbps) || 10;
    const down = Number(policy.bandwidth.downloadMbps) || 50;
    bandwidthStatus = await sshRun(`sudo ${REMOTE_BANDWIDTH} static ${up} ${down}`);
    return { mode: "static", uploadMbps: up, downloadMbps: down, status: bandwidthStatus };
  }
  bandwidthStatus = await sshRun(`sudo ${REMOTE_BANDWIDTH} dynamic`);
  return { mode: "dynamic", status: bandwidthStatus };
}

async function applyDnsPolicy(profile) {
  const policy = loadPolicy();
  if (profile !== "competitive" || !policy.dns.enabled) {
    dnsStatus = await sshRun(`sudo ${REMOTE_DNS} off`);
    return { enabled: false, scope: "xbox-only", status: dnsStatus };
  }
  const primary = policy.dns.primary || "1.1.1.1";
  const secondary = policy.dns.secondary || "";
  dnsStatus = await sshRun(
    `sudo ${REMOTE_DNS} on ${primary}${secondary ? ` ${secondary}` : ""}`,
  );
  return {
    enabled: true,
    scope: "xbox-only",
    primary,
    secondary: secondary || null,
    status: dnsStatus,
  };
}

async function applyCompetitivePolicies(profile) {
  const qos = await applyQosProfile(profile);
  const bandwidth = await applyBandwidthPolicy(profile);
  const dns = await applyDnsPolicy(profile);
  return { ...qos, bandwidth, dns };
}

async function applyQosProfile(profile) {
  if (profile === "balanced") {
    qosStatus = await sshRun(`sudo ${REMOTE_QOS} off`);
    return { profile, qos: qosStatus };
  }
  const ips = ipsForQos(rawSnapshot, profile);
  const tmp = `/tmp/xbox-qos-${Date.now()}.json`;
  qosStatus = await sshRunWithPayload(
    ips,
    tmp,
    `sudo ${REMOTE_QOS} sync ${profile} ${tmp}`,
  );
  return { profile, ipCount: ips.length, qos: qosStatus };
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    if (Date.now() - lastProcessorSample > 30000) {
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
    recordSnapshot(enrichSnapshot(rawSnapshot, trafficProfile), lastRouteData);
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
    sendJson(res, 200, {
      ok: true,
      firewalla: FIREWALLA_HOST,
      xboxIp: XBOX_IP,
      trafficProfile,
      policy: loadPolicy(),
      policySummary: policySummary(),
      hasData: Boolean(rawSnapshot),
      lastError,
      processor: processorTelemetry,
      effectivePollMs,
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
      dnsStatus,
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
        `data: ${JSON.stringify({ data: getLatest(), lastError, trafficProfile, policy: loadPolicy(), policySummary: policySummary(), routeError, routeEnforceError, routeEnforcementEnabled, routeProbing, networkHealth: lastNetworkHealth, networkHealthSummary: networkHealthSummary(lastNetworkHealth), networkHealthError, networkHealthProbing, processor: processorTelemetry, effectivePollMs })}\n\n`,
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
  res.writeHead(200, { "Content-Type": contentType(abs) });
  createReadStream(abs).pipe(res);
});

await pollOnce();
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
  console.log(`  Firewalla: ${FIREWALLA_USER}@${FIREWALLA_HOST}`);
  console.log(`  Xbox IP: ${XBOX_IP}`);
});

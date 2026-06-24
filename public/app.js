const history = [];
const MAX_POINTS = 60;

const els = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  onlinePill: document.getElementById("online-pill"),
  errorBanner: document.getElementById("error-banner"),
  metricDown: document.getElementById("metric-down"),
  metricUp: document.getElementById("metric-up"),
  metricDownDetail: document.getElementById("metric-down-detail"),
  metricUpDetail: document.getElementById("metric-up-detail"),
  metricPkts: document.getElementById("metric-pkts"),
  metricConns: document.getElementById("metric-conns"),
  metricLatency: document.getElementById("metric-latency"),
  metricGaming: document.getElementById("metric-gaming"),
  deviceMeta: document.getElementById("device-meta"),
  sqmMeta: document.getElementById("sqm-meta"),
  flowsBody: document.getElementById("flows-body"),
  policyStatus: document.getElementById("policy-status"),
  policyButtons: document.getElementById("policy-buttons"),
  competitivePanel: document.getElementById("competitive-panel"),
  bandwidthModeButtons: document.getElementById("bandwidth-mode-buttons"),
  bandwidthStaticFields: document.getElementById("bandwidth-static-fields"),
  bwUpload: document.getElementById("bw-upload"),
  bwDownload: document.getElementById("bw-download"),
  bandwidthStatus: document.getElementById("bandwidth-status"),
  bufferModeButtons: document.getElementById("buffer-mode-buttons"),
  bufferStatus: document.getElementById("buffer-status"),
  dnsEnabled: document.getElementById("dns-enabled"),
  dnsFields: document.getElementById("dns-fields"),
  dnsPrimary: document.getElementById("dns-primary"),
  dnsSecondary: document.getElementById("dns-secondary"),
  dnsStatus: document.getElementById("dns-status"),
  applyCompetitiveBtn: document.getElementById("apply-competitive-btn"),
  routeProbeBtn: document.getElementById("route-probe-btn"),
  networkHealthBtn: document.getElementById("network-health-btn"),
  networkHealthStatus: document.getElementById("network-health-status"),
  processorTuneBtn: document.getElementById("processor-tune-btn"),
  processorStatus: document.getElementById("processor-status"),
  procHealth: document.getElementById("proc-health"),
  procHealthDetail: document.getElementById("proc-health-detail"),
  procLoad: document.getElementById("proc-load"),
  procMem: document.getElementById("proc-mem"),
  procPoll: document.getElementById("proc-poll"),
  procDefer: document.getElementById("proc-defer"),
  procFolding: document.getElementById("proc-folding"),
  procFoldingDetail: document.getElementById("proc-folding-detail"),
  procWire: document.getElementById("proc-wire"),
  procWireDetail: document.getElementById("proc-wire-detail"),
  nhNatType: document.getElementById("nh-nat-type"),
  nhNatDetail: document.getElementById("nh-nat-detail"),
  nhWanTopology: document.getElementById("nh-wan-topology"),
  nhWanDetail: document.getElementById("nh-wan-detail"),
  nhLowestMtu: document.getElementById("nh-lowest-mtu"),
  nhMtuDetail: document.getElementById("nh-mtu-detail"),
  nhOffloadScore: document.getElementById("nh-offload-score"),
  nhOffloadDetail: document.getElementById("nh-offload-detail"),
  nhIssues: document.getElementById("nh-issues"),
  mtuBody: document.getElementById("mtu-body"),
  routeEnforceOn: document.getElementById("route-enforce-on"),
  routeEnforceOff: document.getElementById("route-enforce-off"),
  routeEnforceStatus: document.getElementById("route-enforce-status"),
  routeRecommendations: document.getElementById("route-recommendations"),
  routeBlocked: document.getElementById("route-blocked"),
  routeNote: document.getElementById("route-note"),
  regionRankingBody: document.getElementById("region-ranking-body"),
  routesBody: document.getElementById("routes-body"),
  aiAnalyzeBtn: document.getElementById("ai-analyze-btn"),
  aiStatus: document.getElementById("ai-status"),
  aiPhase: document.getElementById("ai-phase"),
  aiSummary: document.getElementById("ai-summary"),
  aiLearning: document.getElementById("ai-learning"),
  aiRecommendations: document.getElementById("ai-recommendations"),
  aiApplyRulesBtn: document.getElementById("ai-apply-rules-btn"),
  destinationsBody: document.getElementById("destinations-body"),
  connsBody: document.getElementById("conns-body"),
  recentBody: document.getElementById("recent-body"),
  footer: document.getElementById("footer"),
  chart: document.getElementById("chart"),
  chartYMax: document.getElementById("chart-y-max"),
  tpNowDown: document.getElementById("tp-now-down"),
  tpNowUp: document.getElementById("tp-now-up"),
  tpPeakDown: document.getElementById("tp-peak-down"),
  tpPeakUp: document.getElementById("tp-peak-up"),
  tpTotalDown: document.getElementById("tp-total-down"),
  tpTotalUp: document.getElementById("tp-total-up"),
  tpWindow: document.getElementById("tp-window"),
  throughputNote: document.getElementById("throughput-note"),
  mocaPathNote: document.getElementById("moca-path-note"),
  mocaDev1Label: document.getElementById("moca-dev1-label"),
  mocaDev1Status: document.getElementById("moca-dev1-status"),
  mocaDev1Detail: document.getElementById("moca-dev1-detail"),
  mocaDev2Label: document.getElementById("moca-dev2-label"),
  mocaDev2Status: document.getElementById("moca-dev2-status"),
  mocaDev2Detail: document.getElementById("moca-dev2-detail"),
  mocaXboxStatus: document.getElementById("moca-xbox-status"),
  mocaXboxDetail: document.getElementById("moca-xbox-detail"),
  securityStatus: document.getElementById("security-status"),
  secSeverity: document.getElementById("sec-severity"),
  secSeverityDetail: document.getElementById("sec-severity-detail"),
  secGuard: document.getElementById("sec-guard"),
  secGuardDetail: document.getElementById("sec-guard-detail"),
  secThroughput: document.getElementById("sec-throughput"),
  secBaseline: document.getElementById("sec-baseline"),
  secConns: document.getElementById("sec-conns"),
  secCap: document.getElementById("sec-cap"),
  secAlerts: document.getElementById("sec-alerts"),
  secEventsBody: document.getElementById("sec-events-body"),
  securityDefendBtn: document.getElementById("security-defend-btn"),
  securityRelaxBtn: document.getElementById("security-relax-btn"),
};

const ctx = els.chart?.getContext("2d") ?? null;

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

function formatEndpoint(item) {
  if (item.hostname && item.ip) {
    return `<strong>${item.hostname}</strong><br><span class="muted-ip">${item.ip}</span>`;
  }
  if (item.label) return item.label;
  if (item.hostname) return item.hostname;
  return item.endpoint || item.remote || item.ip || "—";
}

function kindLabel(kind) {
  if (kind === "active") return "Live";
  if (kind === "recent") return "Recent";
  if (kind === "dns") return "DNS";
  return kind || "—";
}

function formatLatency(ms) {
  if (ms == null || Number.isNaN(ms)) {
    return '<span class="lat-unknown">—</span>';
  }
  const v = Number(ms);
  let cls = "lat-good";
  if (v >= 100) cls = "lat-bad";
  else if (v >= 50) cls = "lat-warn";
  return `<span class="${cls}">${v.toFixed(1)} ms</span>`;
}

function tierClass(tier) {
  return `tier-${tier || "normal"}`;
}

function formatTier(item) {
  const tier = item.effectiveTier || item.tier || "normal";
  const label = item.effectiveTierLabel || item.tierLabel || tier;
  return `<span class="${tierClass(tier)}" title="${item.detail || ""}">${label}</span>`;
}

function formatRole(item) {
  const role = item.role || "Unknown";
  const detail = item.detail ? ` title="${item.detail.replace(/"/g, "&quot;")}"` : "";
  return `<span class="role-name"${detail}>${role}</span>`;
}

let activeProfile = "balanced";
let competitivePolicy = {
  bandwidth: { mode: "static", uploadMbps: 500, downloadMbps: 500 },
  buffers: { mode: "large" },
  dns: { enabled: false, primary: "1.1.1.1", secondary: "1.0.0.1" },
};
let competitiveDirty = false;
let applyingCompetitive = false;
let routeEnforcementEnabled = true;

const BUFFER_LABELS = {
  normal: "normal (512K Xbox burst)",
  large: "large (2M Xbox burst)",
  max: "max (4M Xbox tc burst + NIC rings)",
};

function setProfileButtonActive(profile) {
  document.querySelectorAll(".policy-btn[data-profile]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.profile === profile);
  });
}

function syncCompetitiveFormFromPolicy(policy) {
  if (!policy) return;
  competitivePolicy = {
    bandwidth: { ...competitivePolicy.bandwidth, ...policy.bandwidth },
    buffers: { ...competitivePolicy.buffers, ...policy.buffers },
    dns: { ...competitivePolicy.dns, ...policy.dns },
  };
  els.bwUpload.value = competitivePolicy.bandwidth.uploadMbps ?? 500;
  els.bwDownload.value = competitivePolicy.bandwidth.downloadMbps ?? 500;
  els.dnsEnabled.checked = Boolean(competitivePolicy.dns.enabled);
  els.dnsPrimary.value = competitivePolicy.dns.primary || "1.1.1.1";
  els.dnsSecondary.value = competitivePolicy.dns.secondary || "1.0.0.1";
}

function renderCompetitivePanel(profile, policy, summary, options = {}) {
  const syncForm = options.syncForm !== false;
  const preserveLocalEdits = options.preserveLocalEdits === true;
  const show = profile === "competitive";
  els.competitivePanel.hidden = !show;
  if (!show) return;

  if (policy && syncForm) {
    syncCompetitiveFormFromPolicy(policy);
    competitiveDirty = false;
  } else if (policy && !preserveLocalEdits) {
    syncCompetitiveFormFromPolicy(policy);
    competitiveDirty = false;
  }

  const bwMode = competitivePolicy.bandwidth?.mode || "dynamic";
  document.querySelectorAll("[data-bw-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bwMode === bwMode);
  });
  els.bandwidthStaticFields.hidden = bwMode !== "static";

  const bufMode = competitivePolicy.buffers?.mode || "large";
  document.querySelectorAll("[data-buffer-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bufferMode === bufMode);
  });
  els.dnsFields.hidden = !els.dnsEnabled.checked;

  if (summary) {
    els.bandwidthStatus.textContent = `Bandwidth: ${summary.bandwidth}`;
    if (els.bufferStatus && summary.buffers) {
      els.bufferStatus.textContent = `Buffers: ${summary.buffers}`;
    }
    els.dnsStatus.textContent = `DNS: ${summary.dns}`;
  } else if (competitiveDirty) {
    els.bandwidthStatus.textContent = `Bandwidth: ${bwMode}${bwMode === "static" ? ` (${els.bwUpload.value}/${els.bwDownload.value} Mbps)` : ""} — click Apply competitive settings`;
    if (els.bufferStatus) {
      els.bufferStatus.textContent = `Buffers: ${BUFFER_LABELS[bufMode] || bufMode} — click Apply competitive settings`;
    }
    els.dnsStatus.textContent = `DNS: ${els.dnsEnabled.checked ? "custom (pending)" : "network default"} — click Apply competitive settings`;
  }
}

document.querySelectorAll("[data-bw-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    competitivePolicy.bandwidth.mode = btn.dataset.bwMode;
    competitiveDirty = true;
    renderCompetitivePanel("competitive", competitivePolicy);
  });
});

document.querySelectorAll("[data-buffer-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    competitivePolicy.buffers.mode = btn.dataset.bufferMode;
    competitiveDirty = true;
    renderCompetitivePanel("competitive", competitivePolicy);
    if (activeProfile === "competitive") {
      applyCompetitiveSettings();
    }
  });
});

els.dnsEnabled?.addEventListener("change", () => {
  competitiveDirty = true;
  els.dnsFields.hidden = !els.dnsEnabled.checked;
  renderCompetitivePanel("competitive", competitivePolicy);
});
els.bwUpload?.addEventListener("input", () => { competitiveDirty = true; });
els.bwDownload?.addEventListener("input", () => { competitiveDirty = true; });
els.dnsPrimary?.addEventListener("input", () => { competitiveDirty = true; });
els.dnsSecondary?.addEventListener("input", () => { competitiveDirty = true; });

async function applyCompetitiveSettings() {
  if (applyingCompetitive) return;
  applyingCompetitive = true;
  els.applyCompetitiveBtn.disabled = true;
  if (els.bufferStatus) els.bufferStatus.textContent = "Applying…";
  els.bandwidthStatus.textContent = "Applying…";
  try {
    const body = {
      bandwidth: {
        mode: competitivePolicy.bandwidth.mode,
        uploadMbps: Number(els.bwUpload.value) || 500,
        downloadMbps: Number(els.bwDownload.value) || 500,
      },
      buffers: {
        mode: competitivePolicy.buffers.mode || "large",
      },
      dns: {
        enabled: els.dnsEnabled.checked,
        primary: els.dnsPrimary.value.trim() || "1.1.1.1",
        secondary: els.dnsSecondary.value.trim() || "1.0.0.1",
      },
    };
    const res = await fetch("/api/competitive-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || res.statusText);
    competitiveDirty = false;
    renderCompetitivePanel(activeProfile, payload.policy, payload.summary);
    if (payload.data) {
      renderSnapshot({
        data: payload.data,
        lastError: null,
        trafficProfile: activeProfile,
        routeEnforcementEnabled,
      });
    }
  } catch (err) {
    els.bandwidthStatus.textContent = `Failed: ${err.message}`;
  } finally {
    applyingCompetitive = false;
    els.applyCompetitiveBtn.disabled = false;
  }
}

els.applyCompetitiveBtn?.addEventListener("click", applyCompetitiveSettings);

async function loadCompetitivePolicy() {
  try {
    const res = await fetch("/api/competitive-policy");
    const body = await res.json();
    if (res.ok) {
      activeProfile = body.activeProfile || activeProfile;
      els.policyStatus.textContent = `Profile: ${activeProfile}`;
      setProfileButtonActive(activeProfile);
      renderCompetitivePanel(activeProfile, body.policy, body.summary);
    }
  } catch {
    /* ignore */
  }
}

loadCompetitivePolicy();

async function setRouteEnforcement(enabled) {
  els.routeEnforceStatus.textContent = enabled ? "Enabling firewall path blocks…" : "Disabling path blocks…";
  try {
    const res = await fetch("/api/route-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    routeEnforcementEnabled = body.routeEnforcementEnabled;
    document.querySelectorAll(".route-enforce-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.enabled === String(routeEnforcementEnabled));
    });
    if (body.data) renderSnapshot({ data: body.data, lastError: null, trafficProfile: activeProfile, routeEnforcementEnabled });
  } catch (err) {
    els.routeEnforceStatus.textContent = `Route policy failed: ${err.message}`;
  }
}

els.routeEnforceOn?.addEventListener("click", () => setRouteEnforcement(true));
els.routeEnforceOff?.addEventListener("click", () => setRouteEnforcement(false));

async function runAiAnalysis() {
  els.aiAnalyzeBtn.disabled = true;
  els.aiStatus.textContent = "Refreshing analysis…";
  try {
    const res = await fetch("/api/ai-insights", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    if (body.data) renderSnapshot({ data: body.data, lastError: null, trafficProfile: activeProfile, routeEnforcementEnabled });
  } catch (err) {
    els.aiStatus.textContent = `AI analysis failed: ${err.message}`;
  } finally {
    els.aiAnalyzeBtn.disabled = false;
    els.aiAnalyzeBtn.textContent = "Refresh analysis";
  }
}

els.aiAnalyzeBtn?.addEventListener("click", runAiAnalysis);

async function applySuggestedRules() {
  els.aiApplyRulesBtn.disabled = true;
  try {
    const res = await fetch("/api/ai-rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    els.aiStatus.textContent = `Applied ${body.added} new rule(s) to server-roles.json`;
    if (body.data) renderSnapshot({ data: body.data, lastError: null, trafficProfile: activeProfile, routeEnforcementEnabled });
  } catch (err) {
    els.aiStatus.textContent = `Apply rules failed: ${err.message}`;
  } finally {
    els.aiApplyRulesBtn.disabled = false;
  }
}

els.aiApplyRulesBtn?.addEventListener("click", applySuggestedRules);

function renderAiInsights(ai) {
  if (!ai) {
    els.aiPhase.innerHTML = "";
    els.aiSummary.innerHTML = "";
    els.aiLearning.innerHTML = "";
    els.aiRecommendations.innerHTML = "";
    els.aiApplyRulesBtn.style.display = "none";
    return;
  }
  const phase = ai.sessionPhase || ai.phase;
  if (phase) {
    const game = phase.game?.label || ai.learning?.game?.label;
    const gameBadge = game && game !== "Xbox gaming" ? ` · ${game}` : "";
    els.aiPhase.innerHTML = `<span class="ai-phase-pill">${(phase.phase || phase).replace(/-/g, " ")}</span>${gameBadge} ${phase.detail || ""}`;
  }
  const status = ai.status || ai.advisor;
  if (status?.engine) {
    els.aiStatus.textContent = `Local advisor — ${status.engine}`;
  } else {
    els.aiStatus.textContent = "Local advisor — heuristics + learning + outcomes";
  }
  if (ai.summary) {
    els.aiSummary.innerHTML = `<div class="ai-summary-box">${ai.summary.replace(/\n/g, "<br>")}</div>`;
  } else {
    els.aiSummary.innerHTML = "";
  }

  const learning = ai.learning || {};
  const parts = [];
  if (ai.adaptiveThresholds?.source === "learned") {
    parts.push(`Adaptive thresholds: path +${ai.adaptiveThresholds.slowPathDeltaMs} ms, region +${ai.adaptiveThresholds.slowRegionDeltaMs} ms`);
  }
  if (learning.lobbyPrediction) {
    const lp = learning.lobbyPrediction;
    parts.push(`<span class="eff-${lp.risk === "high" ? "poor" : lp.risk === "medium" ? "fair" : "good"}">Lobby risk: ${lp.risk}</span> — ${lp.detail}`);
  }
  if ((learning.bandwidthSpikes || []).length) {
    parts.push(`Bandwidth: ${learning.bandwidthSpikes.map((s) => s.message).join("; ")}`);
  }
  const os = learning.outcomeStats?.trafficProfile;
  if (os?.evaluated >= 2 && os.successRate != null) {
    parts.push(`Competitive profile helped ${Math.round(os.successRate * 100)}% of ${os.evaluated} tracked cases`);
  }
  if (learning.sessions?.active) {
    const s = learning.sessions.active;
    parts.push(`Active session: ${s.gameLabel || s.gameId} · ${s.phases?.length || 1} phase(s)`);
  } else if ((learning.sessions?.recent || []).length) {
    const last = learning.sessions.recent[0];
    parts.push(`Last session: ${last.gameLabel || last.gameId} · ${last.durationSec ? `${last.durationSec}s` : "?"}`);
  }
  for (const p of learning.sessions?.patterns || []) {
    parts.push(p);
  }
  if ((learning.roleRuleSuggestions || []).length) {
    parts.push(`${learning.roleRuleSuggestions.length} hostname rule(s) ready to apply`);
    els.aiApplyRulesBtn.style.display = "inline-block";
  } else {
    els.aiApplyRulesBtn.style.display = "none";
  }
  els.aiLearning.innerHTML = parts.length
    ? `<div class="ai-summary-box">${parts.join("<br>")}</div>`
    : "";

  const recs = ai.recommendations || [];
  els.aiRecommendations.innerHTML = recs.length
    ? recs.map((r, idx) => {
        const cls = r.priority === "high" ? "route-rec route-rec-high" : r.priority === "medium" ? "route-rec route-rec-med" : "route-rec";
        const actionBtn = r.action
          ? `<button type="button" class="policy-btn ai-action-btn" data-rec-idx="${idx}">Apply</button>`
          : "";
        return `<div class="${cls} ai-rec-card" data-rec-idx="${idx}"><strong>${r.title}</strong><br><span class="muted-ip">${r.detail}</span>${actionBtn ? `<div class="ai-rec-actions">${actionBtn}</div>` : ""}</div>`;
      }).join("")
    : "";
  els.aiRecommendations.querySelectorAll(".ai-action-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.recIdx);
      const rec = recs[idx];
      if (rec?.action) executeRecommendationAction(rec.action, rec);
    });
  });
}

async function executeRecommendationAction(action, rec) {
  if (!action?.type) return;
  els.aiStatus.textContent = `Applying: ${rec?.title || action.type}…`;
  try {
    switch (action.type) {
      case "traffic-profile":
        await setTrafficProfile(action.value);
        break;
      case "route-probe":
        await probeRoutes();
        break;
      case "route-enforce-on":
        await setRouteEnforcement(true);
        break;
      case "network-health-probe":
        await probeNetworkHealth();
        break;
      case "processor-tune": {
        const res = await fetch("/api/processor-tune", { method: "POST" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        if (body.processor) renderProcessor(body.processor, body.processor.pollMs);
        break;
      }
      case "apply-rule": {
        const res = await fetch("/api/ai-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rules: [action.value] }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        els.aiStatus.textContent = `Applied rule for ${action.value?.hostname || "host"}`;
        break;
      }
      default:
        throw new Error(`Unknown action: ${action.type}`);
    }
    els.aiStatus.textContent = `Applied: ${rec?.title || action.type}`;
    await runAiAnalysis();
  } catch (err) {
    els.aiStatus.textContent = `Action failed: ${err.message}`;
  }
}

async function setTrafficProfile(profile) {
  els.policyStatus.textContent = `Applying ${profile}…`;
  try {
    const res = await fetch("/api/traffic-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    activeProfile = profile;
    els.policyStatus.textContent = `Profile: ${profile}${body.ipCount != null ? ` (${body.ipCount} IPs shaped)` : ""}`;
    setProfileButtonActive(profile);
    renderCompetitivePanel(profile, body.policy, body.policySummary);
    if (body.data) renderSnapshot({ data: body.data, lastError: null, trafficProfile: profile });
  } catch (err) {
    els.policyStatus.textContent = `Failed: ${err.message}`;
  }
}

document.querySelectorAll(".policy-btn[data-profile]").forEach((btn) => {
  btn.addEventListener("click", () => setTrafficProfile(btn.dataset.profile));
});
document.querySelector('.policy-btn[data-profile="balanced"]')?.classList.add("active");

function formatEfficiency(e) {
  if (!e || e === "unknown") return '<span class="lat-unknown">—</span>';
  return `<span class="eff-${e}">${e}</span>`;
}

function formatRouteCell(item) {
  if (item.routePingMs == null && item.routeScore == null) return "—";
  const bn = item.routeBottleneck;
  const parts = [];
  if (item.routeStack) parts.push(item.routeStack);
  if (item.routePingMs != null) parts.push(`${Number(item.routePingMs).toFixed(1)} ms`);
  else if (item.routeScore != null) parts.push(`${item.routeHops ?? "?"} hops · ${item.routeScore}`);
  const qual = item.routePathQuality;
  if (qual === "suboptimal") parts.push("⚠ suboptimal");
  const tip = [
    bn ? `Bottleneck hop ${bn.hop}: +${bn.deltaMs} ms` : "",
    item.routePathNote || "",
  ].filter(Boolean).join(" · ");
  const cls = qual === "suboptimal" ? "eff-poor" : `eff-${item.routeEfficiency || "unknown"}`;
  return `<span class="${cls}"${tip ? ` title="${tip.replace(/"/g, "&quot;")}"` : ""}>${parts.join(" · ")}</span>`;
}

async function probeRoutes() {
  els.routeProbeBtn.disabled = true;
  els.routeProbeBtn.textContent = "Probing…";
  els.routeNote.textContent = "Running traceroute to Azure regions and live game servers (may take 1–2 min)…";
  try {
    const res = await fetch("/api/route-probe", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderSnapshot({ data: body.data, lastError: null, trafficProfile: activeProfile });
  } catch (err) {
    els.routeNote.textContent = `Route probe failed: ${err.message}`;
  } finally {
    els.routeProbeBtn.disabled = false;
    els.routeProbeBtn.textContent = "Probe routes now";
  }
}

els.routeProbeBtn?.addEventListener("click", probeRoutes);

function severityClass(severity) {
  if (severity === "critical") return "sec-critical";
  if (severity === "high") return "sec-high";
  if (severity === "warn") return "sec-warn";
  return "sec-ok";
}

function formatSecTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}

function renderSecurityTelemetry(telemetry, floodGuard) {
  const sec = telemetry || {};
  const guard = floodGuard || {};
  const metrics = sec.metrics;
  const baseline = sec.baseline;
  const cap = sec.bandwidthCapMbps || { upload: 500, download: 500 };

  if (!metrics && sec.status === "waiting") {
    els.securityStatus.textContent = "Building baseline — need a few poll cycles with Xbox online.";
    return;
  }

  const severity = sec.severity || sec.status || "ok";
  const sevLabel = severity === "ok" ? "NORMAL" : severity.toUpperCase();
  els.secSeverity.innerHTML = `<span class="${severityClass(severity)}">${sevLabel}</span>`;
  els.secSeverityDetail.textContent =
    sec.score != null ? `Score ${sec.score} — ${metrics?.xboxOnline ? "Xbox online" : "Xbox offline"}` : "Monitoring inbound patterns";

  const guardOn = guard.active || sec.guardActive;
  els.secGuard.innerHTML = guardOn
    ? '<span class="sec-high">ACTIVE</span>'
    : '<span class="sec-ok">OFF</span>';
  els.secGuardDetail.textContent = guardOn
    ? "Per-source flood limits on Firewalla — Xbox Live ports whitelisted"
    : "Auto-activates on inbound flood / boot patterns";
  if (guard.error) {
    els.secGuardDetail.textContent = `Guard error: ${guard.error}`;
  }

  if (metrics) {
    els.secThroughput.textContent = `${metrics.inboundMbps} ↓ / ${metrics.outboundMbps} ↑ Mbps`;
    if (baseline) {
      els.secBaseline.textContent = `Baseline ~${baseline.inboundMbps} ↓ / ${baseline.outboundMbps} ↑ Mbps · ${baseline.connections ?? "?"} conns`;
    } else {
      els.secBaseline.textContent = "Baseline calibrating…";
    }
    els.secConns.textContent = `${metrics.connections} conns · ${metrics.totalKpps} kpps`;
  } else {
    els.secThroughput.textContent = "—";
    els.secBaseline.textContent = "—";
    els.secConns.textContent = "—";
  }

  els.secCap.textContent = `Xbox cap: ${cap.upload} ↑ / ${cap.download} ↓ Mbps`;

  const alerts = sec.alerts || [];
  els.secAlerts.innerHTML = alerts.length
    ? alerts.map((a) => {
        const cls = a.type === "inbound_flood" || a.type === "packet_storm" ? "route-rec route-rec-high" : "route-rec route-rec-med";
        return `<div class="${cls}"><strong>${(a.type || "alert").replace(/_/g, " ")}</strong><br><span class="muted-ip">${a.detail || ""}</span></div>`;
      }).join("")
    : "";

  const events = sec.recentEvents || [];
  els.secEventsBody.innerHTML = events.length
    ? events
        .slice()
        .reverse()
        .map((e) => `<tr>
            <td>${formatSecTime(e.at)}</td>
            <td><code>${e.type || e.severity || "—"}</code></td>
            <td>${e.detail || "—"}</td>
          </tr>`)
        .join("")
    : "<tr><td colspan=\"3\">No security events yet</td></tr>";

  if (guardOn) {
    els.securityStatus.textContent =
      "Flood guard ON — per-source inbound limits active; Xbox Live / Warzone ports whitelisted.";
  } else if (alerts.length) {
    els.securityStatus.textContent = "Suspicious inbound pattern detected — guard will auto-activate if severity rises.";
  } else {
    els.securityStatus.textContent = "Firewalla inbound flood detection — auto-defends Xbox during boot/flood patterns.";
  }
}

async function setSecurityGuard(mode) {
  els.securityStatus.textContent = mode === "defend" ? "Activating flood guard…" : "Relaxing flood guard…";
  try {
    const res = await fetch("/api/security-guard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderSecurityTelemetry(body.telemetry, { active: mode === "defend", status: body.status });
  } catch (err) {
    els.securityStatus.textContent = `Guard action failed: ${err.message}`;
  }
}

els.securityDefendBtn?.addEventListener("click", () => setSecurityGuard("defend"));
els.securityRelaxBtn?.addEventListener("click", () => setSecurityGuard("relax"));

function natClass(natType) {
  if (natType === "open") return "nh-nat-open";
  if (natType === "moderate") return "nh-nat-moderate";
  if (natType === "strict") return "nh-nat-strict";
  return "nh-nat-unknown";
}

function renderNetworkHealth(health, summary, probing, error) {
  if (probing) {
    els.networkHealthStatus.textContent = "Probing NAT type, path MTU, and hardware offload (may take ~30s)…";
    return;
  }
  if (error) {
    els.networkHealthStatus.textContent = `Network health error: ${error}`;
  } else if (health?.probedAt) {
    els.networkHealthStatus.textContent = `Last probe ${new Date(health.probedAt).toLocaleString()} — NAT, MTU & offload from Firewalla`;
  } else {
    els.networkHealthStatus.textContent = "NAT type and path MTU — detects double NAT, UPnP, and fragmentation risk.";
  }

  const nat = health?.nat || {};
  const mtu = health?.mtu || {};
  const sum = summary || {};

  const natLabel = (nat.xboxNatEquivalent || sum.xboxNatEquivalent || "—").toUpperCase();
  els.nhNatType.innerHTML = `<span class="${natClass(nat.natType || sum.natType)}">${natLabel}</span>`;
  els.nhNatDetail.textContent = nat.detail || "—";

  if (sum.doubleNat || nat.wan?.doubleNat) {
    els.nhWanTopology.innerHTML = '<span class="nh-nat-strict">Double NAT</span>';
    els.nhWanDetail.textContent = `Firewalla WAN ${nat.wan?.wanIp || "?"} via ${nat.wan?.wanGateway || "upstream router"} — public ${nat.wan?.publicIp || "?"}`;
  } else if (nat.wan?.wanPrivate) {
    els.nhWanTopology.innerHTML = '<span class="nh-nat-moderate">Private WAN</span>';
    els.nhWanDetail.textContent = `WAN IP ${nat.wan?.wanIp || "?"}`;
  } else {
    els.nhWanTopology.innerHTML = '<span class="nh-nat-open">Direct</span>';
    els.nhWanDetail.textContent = `Public ${nat.wan?.publicIp || nat.wan?.wanIp || "?"}`;
  }

  const lowest = mtu.summary?.lowestMtu ?? sum.mtuLowest;
  els.nhLowestMtu.textContent = lowest != null ? `${lowest}` : "—";
  els.nhMtuDetail.textContent = mtu.recommendation || "—";

  const offload = health?.offload || {};
  const offSum = offload.summary || {};
  const offScore = offSum.overallScore ?? sum.offloadScore;
  const offStatus = offSum.status || sum.offloadStatus || "unknown";
  if (offScore != null) {
    const cls =
      offStatus === "good" ? "nh-nat-open" : offStatus === "fair" ? "nh-nat-moderate" : "nh-nat-unknown";
    els.nhOffloadScore.innerHTML = `<span class="${cls}">${offScore}/100</span>`;
    const path = offload.path || {};
    const br2 = offload.interfaces?.[path.lan || "br2"]?.scorecard;
    const parts = [
      `igc GRO/GSO/checksum on eth0–eth2`,
      br2?.qdisc ? `${path.lan || "br2"} qdisc ${br2.qdisc}` : null,
    ].filter(Boolean);
    els.nhOffloadDetail.textContent = parts.join(" · ");
  } else {
    els.nhOffloadScore.textContent = "—";
    els.nhOffloadDetail.textContent = "Run probe to audit NIC offloads";
  }

  const issues = [...(nat.issues || []), ...(offSum.issues || [])];
  if (nat.degraded) {
    issues.unshift(`NAT degraded from ${nat.changedFrom} to ${nat.natType}`);
  }
  els.nhIssues.innerHTML = issues.length
    ? issues.map((issue) => `<div class="route-rec route-rec-high"><strong>⚠</strong> ${issue}</div>`).join("")
    : "";

  const rows = mtu.targets || [];
  els.mtuBody.innerHTML = rows.length
    ? rows
        .map((r) => {
          const risk = r.fragmentationRisk ? "Yes" : "No";
          const riskCls = r.fragmentationRisk ? "risk-yes" : "risk-no";
          return `<tr>
            <td>${r.label || "—"}</td>
            <td><code>${r.ip || "—"}</code></td>
            <td>${r.stack || "—"}</td>
            <td>${r.pathMtu != null ? `${r.pathMtu} B` : "—"}</td>
            <td class="${riskCls}">${risk}</td>
          </tr>`;
        })
        .join("")
    : "<tr><td colspan=\"5\">No MTU data — run probe</td></tr>";
}

async function probeNetworkHealth() {
  els.networkHealthBtn.disabled = true;
  els.networkHealthBtn.textContent = "Probing…";
  renderNetworkHealth(null, null, true, null);
  try {
    const res = await fetch("/api/network-health", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderNetworkHealth(body.health, body.summary, false, null);
    if (body.data) {
      renderSnapshot({
        data: body.data,
        lastError: null,
        trafficProfile: activeProfile,
        routeEnforcementEnabled,
        networkHealth: body.health,
        networkHealthSummary: body.summary,
      });
    }
  } catch (err) {
    renderNetworkHealth(null, null, false, err.message);
  } finally {
    els.networkHealthBtn.disabled = false;
    els.networkHealthBtn.textContent = "Probe NAT & MTU";
  }
}

els.networkHealthBtn?.addEventListener("click", probeNetworkHealth);

function healthClass(status) {
  if (status === "ok") return "proc-ok";
  if (status === "busy") return "proc-busy";
  if (status === "stressed") return "proc-stressed";
  return "proc-unknown";
}

function renderProcessor(processor, effectivePollMs, tuning) {
  if (!processor) {
    els.procHealth.textContent = "—";
    els.procHealth.className = "nh-metric processor-health proc-unknown";
    els.procHealthDetail.textContent = "Waiting for first load sample…";
    els.procLoad.textContent = "—";
    els.procMem.textContent = "—";
    els.procPoll.textContent = "—";
    els.procDefer.textContent = "—";
    els.procFolding.textContent = "—";
    els.procFoldingDetail.textContent = "Run a route probe to fold path features.";
    els.procWire.textContent = "—";
    els.procWireDetail.textContent = "—";
    return;
  }

  const health = processor.health || {};
  const status = health.status || "unknown";
  els.procHealth.textContent = status;
  els.procHealth.className = `nh-metric processor-health ${healthClass(status)}`;
  els.procHealthDetail.textContent = health.detail || "—";

  const load = processor.load;
  els.procLoad.textContent = load
    ? `${load.load1?.toFixed(2) ?? "?"} / ${load.load5?.toFixed(2) ?? "?"} / ${load.load15?.toFixed(2) ?? "?"}`
    : "—";
  els.procMem.textContent =
    processor.memAvailableMb != null
      ? `${processor.memAvailableMb} MB free`
      : "Memory: —";

  const pollMs = effectivePollMs ?? processor.pollMs;
  const baseMs = processor.basePollMs;
  els.procPoll.textContent =
    pollMs != null ? `${(pollMs / 1000).toFixed(1)}s` : "—";
  els.procDefer.textContent =
    baseMs && pollMs && pollMs > baseMs
      ? `Adaptive (+${Math.round(((pollMs - baseMs) / baseMs) * 100)}% vs ${baseMs / 1000}s base)`
      : baseMs
        ? `Base ${baseMs / 1000}s`
        : "—";
  if (processor.deferHeavyProbes) {
    els.procDefer.textContent += " · heavy probes deferred";
  }
  if (processor.snapshotMode && processor.snapshotMode !== "normal") {
    els.procDefer.textContent += ` · snapshot ${processor.snapshotMode}`;
  } else if (processor.memoryPressure && processor.memoryPressure !== "ok" && processor.memoryPressure !== "unknown") {
    els.procDefer.textContent += ` · memory ${processor.memoryPressure}`;
  }

  const preabstract = processor.preabstract || null;
  if (preabstract?.mode && preabstract.mode !== "normal") {
    els.procWireDetail.textContent = [
      els.procWireDetail.textContent,
      `On-box preabstract: ${preabstract.mode}${preabstract.memAvailableMb != null ? ` (${preabstract.memAvailableMb} MB free)` : ""}`,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  const folding = processor.folding;
  if (folding) {
    const pres = folding.preservation != null ? `${(folding.preservation * 100).toFixed(1)}%` : "—";
    const ratio = folding.compressionRatio != null ? `${folding.compressionRatio.toFixed(2)}×` : "—";
    els.procFolding.textContent = `${pres} preserved`;
    const parts = [
      folding.method ? `Method: ${folding.method}` : null,
      `Compression ${ratio}`,
      folding.equivalenceClassCount != null
        ? `${folding.equivalenceClassCount} latency classes`
        : null,
    ].filter(Boolean);
    els.procFoldingDetail.textContent = parts.join(" · ");
  } else {
    els.procFolding.textContent = "No probe data";
    els.procFoldingDetail.textContent = "Route folding applies after a route probe.";
  }

  const wire = processor.wire;
  const tp = processor.throughput || {};
  if (wire?.compressionRatio > 1) {
    const rawKb = ((wire.rawBytes || 0) / 1024).toFixed(1);
    const wireKb = ((wire.wireBytes || 0) / 1024).toFixed(1);
    els.procWire.textContent = `${wire.compressionRatio.toFixed(2)}× smaller`;
    els.procWireDetail.textContent = `Snapshot API ${rawKb} KB → ${wireKb} KB (${wire.mode || "gzip"})`;
  } else if (tp.effectiveControlPlaneKbps != null && tp.physicalDownKbps != null) {
    els.procWire.textContent = `${(tp.effectiveControlPlaneKbps / Math.max(tp.physicalDownKbps, 1)).toFixed(2)}× eff.`;
    els.procWireDetail.textContent = `Control-plane effective ${tp.effectiveControlPlaneKbps.toFixed(0)} Kbps`;
  } else {
    els.procWire.textContent = wire?.mode === "plain-json" ? "Plain JSON" : "Active";
    els.procWireDetail.textContent = wire
      ? `${wire.rawBytes || "?"} B raw over API`
      : "Gzip wire from Firewalla snapshot";
  }

  if (tuning?.busy) {
    els.processorStatus.textContent = "Applying processor tune on Firewalla…";
  } else if (tuning?.error) {
    els.processorStatus.textContent = `Tune error: ${tuning.error}`;
  } else if (processor.sampledAt) {
    els.processorStatus.textContent = `Last sample ${new Date(processor.sampledAt).toLocaleString()} — dimensional folding on telemetry, load-aware poll scheduling.`;
  }
}

async function applyProcessorTune() {
  els.processorTuneBtn.disabled = true;
  els.processorTuneBtn.textContent = "Tuning…";
  renderProcessor(null, null, { busy: true });
  try {
    const res = await fetch("/api/processor-tune", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderProcessor(body.processor, body.processor?.pollMs, { error: body.error });
    if (body.data) {
      renderSnapshot({
        data: body.data,
        processor: body.processor,
        effectivePollMs: body.processor?.pollMs,
      });
    }
  } catch (err) {
    renderProcessor(null, null, { error: err.message });
  } finally {
    els.processorTuneBtn.disabled = false;
    els.processorTuneBtn.textContent = "Apply tune";
  }
}

els.processorTuneBtn?.addEventListener("click", applyProcessorTune);

function renderRouteAnalysis(analysis, routeProbing, enforcementEnabled) {
  if (routeProbing) {
    els.routeNote.textContent = "Probing all path candidates (IPv4 + IPv6)…";
    return;
  }
  if (!analysis) {
    els.routesBody.innerHTML = "<tr><td colspan=\"6\">No route data yet — click Probe routes now.</td></tr>";
    els.regionRankingBody.innerHTML = "<tr><td colspan=\"6\">Run a probe to rank datacenter paths…</td></tr>";
    els.routeRecommendations.innerHTML = "";
    els.routeBlocked.innerHTML = "";
    return;
  }

  const active = enforcementEnabled ?? analysis.enforcementActive ?? true;
  document.querySelectorAll(".route-enforce-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.enabled === String(active));
  });

  const enf = analysis.enforcement;
  const blocked = enf?.blocked || [];
  if (active && blocked.length) {
    els.routeEnforceStatus.textContent =
      `Firewall blocking ${blocked.length} slow path(s) — best region: ${enf.bestRegion || "—"}`;
    els.routeBlocked.innerHTML =
      `<details class="role-legend"><summary>Blocked slow paths (${blocked.length})</summary><ul class="blocked-list">` +
      blocked.map((b) => `<li><code>${b.ip}</code> — ${b.detail || b.reason}${b.region ? ` (${b.region})` : ""}</li>`).join("") +
      "</ul></details>";
  } else if (active) {
    els.routeEnforceStatus.textContent = "Enforcement on — no slow alternates detected yet (run probe during gaming).";
    els.routeBlocked.innerHTML = "";
  } else {
    els.routeEnforceStatus.textContent = "Enforcement off — all paths allowed.";
    els.routeBlocked.innerHTML = "";
  }

  els.routeNote.textContent = analysis.routingNote || "Internet path analysis from Firewalla.";
  const recs = analysis.recommendations || [];
  els.routeRecommendations.innerHTML = recs.length
    ? recs.map((r) => {
        const cls = r.priority === "high" ? "route-rec route-rec-high" : r.priority === "medium" ? "route-rec route-rec-med" : "route-rec";
        return `<div class="${cls}"><strong>${r.title}</strong><br><span class="muted-ip">${r.detail}</span></div>`;
      }).join("")
    : "";

  const ranking = analysis.regionRanking || [];
  els.regionRankingBody.innerHTML = ranking.length
    ? ranking.map((r) => `<tr class="${r.chosen ? "route-best" : ""}">
        <td>${r.rank}</td>
        <td>${r.region || "—"}${r.chosen ? " ★" : ""}</td>
        <td>${formatLatency(r.pingMs)}</td>
        <td>${r.stack || "—"}</td>
        <td>${r.hopCount ?? "—"}</td>
        <td>${formatEfficiency(r.efficiency)}</td>
      </tr>`).join("")
    : "<tr><td colspan=\"6\">No region probes in last run</td></tr>";

  const routes = analysis.routes || [];
  els.routesBody.innerHTML = routes.length
    ? routes
        .map((r) => {
          const alts = (r.pathCandidates || []).filter((c) => !c.chosen);
          const altTip = alts.length
            ? ` title="${alts.map((c) => `${c.stack}: ${c.pingMs != null ? c.pingMs.toFixed(1) + " ms" : "no reply"}`).join(", ")}"`
            : "";
          return `<tr class="${r.pathChosen ? "route-best" : ""}">
            <td>${r.region || r.label || r.hostname || r.ip || "—"}</td>
            <td${altTip}>${r.stack || "—"}${r.pathNote ? `<br><span class="muted-ip">${r.pathNote}</span>` : ""}</td>
            <td>${formatLatency(r.pingMs ?? r.finalRttMs)}</td>
            <td>${r.hopCount ?? "—"}</td>
            <td>${r.score ?? "—"}</td>
            <td>${formatEfficiency(r.efficiency)}</td>
          </tr>`;
        })
        .join("")
    : "<tr><td colspan=\"6\">No routes returned</td></tr>";
}

function formatKbps(bytes, windowSec) {
  if (!bytes || !windowSec) return "0";
  return ((bytes * 8) / windowSec / 1000).toFixed(1);
}

function formatMbps(bytes, windowSec) {
  if (!bytes || !windowSec) return 0;
  return (bytes * 8) / windowSec / 1_000_000;
}

function formatRateLabel(kbps) {
  const v = Number(kbps) || 0;
  if (v >= 1000) return `${(v / 1000).toFixed(2)} Mbps`;
  return `${v.toFixed(1)} Kbps`;
}

function formatRatePair(kbps) {
  const v = Number(kbps) || 0;
  const mbps = v / 1000;
  if (v >= 1000) return `${mbps.toFixed(2)} Mbps (${Math.round(v)} Kbps)`;
  return `${v.toFixed(1)} Kbps`;
}

function formatMbTotal(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  if (mb >= 0.001) return `${(mb * 1024).toFixed(1)} KB`;
  return "0 B";
}

function throughputSummary() {
  if (!history.length) {
    return { peakDown: 0, peakUp: 0, totalDownBytes: 0, totalUpBytes: 0 };
  }
  let peakDown = 0;
  let peakUp = 0;
  let totalDownBytes = 0;
  let totalUpBytes = 0;
  for (const p of history) {
    peakDown = Math.max(peakDown, p.downKbps || 0);
    peakUp = Math.max(peakUp, p.upKbps || 0);
    totalDownBytes += p.downBytes || 0;
    totalUpBytes += p.upBytes || 0;
  }
  return { peakDown, peakUp, totalDownBytes, totalUpBytes };
}

function renderMocaPath(moca, accessPath, mocaTrack) {
  const track = mocaTrack || null;
  const pathLabel = accessPath || "ScreenBeam MoCA (Xbox-dedicated)";

  if (track?.adapters?.length) {
    const [a1, a2] = track.adapters;
    if (a1 && els.mocaDev1Label) {
      els.mocaDev1Label.textContent = a1.label || "MoCA .13";
      els.mocaDev1Status.innerHTML = a1.online
        ? `<span class="sec-ok">ONLINE</span> ${a1.avgMs} ms`
        : `<span class="sec-high">OFFLINE</span>`;
      els.mocaDev1Detail.textContent = [
        a1.ip,
        a1.firmware ? `fw ${a1.firmware}` : null,
        a1.mocaLink ? `MoCA ${a1.mocaLink}` : null,
        a1.ethSpeed ? `eth ${a1.ethSpeed}` : null,
        a1.networkSearch === false ? "search off" : a1.networkSearch ? "search on" : null,
        a1.preferredNc ? "preferred NC" : null,
        a1.jitterMs != null ? `jitter ${a1.jitterMs} ms` : null,
      ].filter(Boolean).join(" · ");
    }
    if (a2 && els.mocaDev2Label) {
      els.mocaDev2Label.textContent = a2.label || "MoCA .19";
      els.mocaDev2Status.innerHTML = a2.online
        ? `<span class="sec-ok">ONLINE</span> ${a2.avgMs} ms`
        : `<span class="sec-high">OFFLINE</span>`;
      els.mocaDev2Detail.textContent = [
        a2.ip,
        a2.firmware ? `fw ${a2.firmware}` : null,
        a2.mocaLink ? `MoCA ${a2.mocaLink}` : null,
        a2.ethSpeed ? `eth ${a2.ethSpeed}` : null,
        a2.networkSearch === false ? "search off" : a2.networkSearch ? "search on" : null,
        a2.jitterMs != null ? `jitter ${a2.jitterMs} ms` : null,
      ].filter(Boolean).join(" · ");
    }
    const xp = track.xboxPath || track.path || {};
    if (els.mocaXboxStatus) {
      const jitter = xp.jitterMs ?? track.path?.jitterMs;
      els.mocaXboxStatus.innerHTML = xp.online !== false
        ? `<span class="sec-ok">${xp.avgMs ?? track.path?.avgMs ?? "—"} ms</span>`
        : `<span class="sec-high">—</span>`;
      els.mocaXboxDetail.textContent = [
        xp.ip || "192.168.167.65",
        jitter != null ? `jitter ${jitter} ms` : null,
        track.path?.estimatedMocaHopMs != null ? `est. MoCA hop ${track.path.estimatedMocaHopMs} ms` : null,
      ].filter(Boolean).join(" · ");
    }
    const allOk = track.adapters.every((a) => a.online) && (track.path?.ok ?? true);
    els.mocaPathNote.textContent = allOk
      ? `${pathLabel} — adapters .13 & .19 online · end-to-end stable`
      : `${pathLabel} — check offline MoCA adapter`;
    return;
  }

  if (!moca?.ok) {
    els.mocaPathNote.textContent = moca?.error
      ? `${pathLabel} — probe error: ${moca.error}`
      : `${pathLabel} — probing Firewalla → Xbox latency…`;
    return;
  }
  const jitter = moca.jitterMs ?? 0;
  const jitterNote =
    jitter > 3
      ? " — elevated jitter, check coax/terminations"
      : jitter > 1.5
        ? " — moderate jitter"
        : " — stable";
  els.mocaPathNote.textContent =
    `${pathLabel}: ${moca.avgMs} ms avg (${moca.minMs}–${moca.maxMs} ms), jitter ${jitter} ms${jitterNote}`;
}

function renderThroughputDetails(sample, windowSec) {
  const downKbps = Number(formatKbps(sample.bytesIn, windowSec));
  const upKbps = Number(formatKbps(sample.bytesOut, windowSec));
  const downMbps = formatMbps(sample.bytesIn, windowSec);
  const upMbps = formatMbps(sample.bytesOut, windowSec);
  const { peakDown, peakUp, totalDownBytes, totalUpBytes } = throughputSummary();

  els.metricDown.innerHTML = `${downKbps.toFixed(1)} <small>Kbps</small>`;
  els.metricUp.innerHTML = `${upKbps.toFixed(1)} <small>Kbps</small>`;
  els.metricDownDetail.textContent = `${downMbps.toFixed(2)} Mbps · ${formatMbTotal(sample.bytesIn)} in ${windowSec}s window`;
  els.metricUpDetail.textContent = `${upMbps.toFixed(2)} Mbps · ${formatMbTotal(sample.bytesOut)} in ${windowSec}s window`;

  if (els.tpNowDown) {
    els.tpNowDown.textContent = `${formatRateLabel(downKbps)} · ${formatMbTotal(sample.bytesIn)}`;
    els.tpNowUp.textContent = `${formatRateLabel(upKbps)} · ${formatMbTotal(sample.bytesOut)}`;
    els.tpPeakDown.textContent = formatRatePair(peakDown);
    els.tpPeakUp.textContent = formatRatePair(peakUp);
    els.tpTotalDown.textContent = formatMbTotal(totalDownBytes);
    els.tpTotalUp.textContent = formatMbTotal(totalUpBytes);
    els.tpWindow.textContent = `${windowSec}s · ${history.length} samples · cap 500/500 Mbps`;
  }

  if (els.throughputNote) {
    const pkNote =
      peakDown >= 1000 || peakUp >= 100
        ? ` Peak download ${formatRateLabel(peakDown)} · session ${formatMbTotal(totalDownBytes)} down / ${formatMbTotal(totalUpBytes)} up.`
        : "";
    els.throughputNote.textContent = `Sample ${windowSec}s window from Firewalla.${pkNote}`;
  }
}

function setError(message) {
  if (!message) {
    els.errorBanner.classList.remove("visible");
    els.errorBanner.textContent = "";
    return;
  }
  els.errorBanner.textContent = message;
  els.errorBanner.classList.add("visible");
}

function renderChart() {
  if (!ctx || !els.chart) return;
  const w = els.chart.width;
  const h = els.chart.height;
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) return;

  const max = Math.max(
    ...history.flatMap((p) => [p.downKbps, p.upKbps, 1]),
  );
  const pad = 28;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  if (els.chartYMax) {
    els.chartYMax.textContent = max >= 1000 ? `${(max / 1000).toFixed(1)} Mbps` : `${Math.round(max)} Kbps`;
  }

  ctx.strokeStyle = "#243044";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8ea0b8";
  ctx.font = "11px Segoe UI, system-ui, sans-serif";
  for (let i = 0; i <= 3; i++) {
    const y = pad + (innerH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
    const tickVal = max - (max / 3) * i;
    const label = tickVal >= 1000 ? `${(tickVal / 1000).toFixed(1)}M` : `${Math.round(tickVal)}K`;
    ctx.fillText(label, 4, y + 4);
  }

  function drawLine(key, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    history.forEach((point, idx) => {
      const x = pad + (innerW * idx) / (MAX_POINTS - 1);
      const y = pad + innerH - (point[key] / max) * innerH;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawLine("downKbps", "#4dabf7");
  drawLine("upKbps", "#3dd68c");
}

function renderSnapshot(payload) {
  const {
    data,
    lastError,
    trafficProfile: profile,
    routeError,
    routeEnforceError,
    routeProbing,
    routeEnforcementEnabled: reEnabled,
    policy,
    policySummary: pSummary,
    networkHealth,
    networkHealthSummary,
    networkHealthError,
    networkHealthProbing,
    processor,
    effectivePollMs,
    security,
    floodGuard,
    mocaPath,
    mocaTrack,
    accessPath,
  } = payload;
  setError(lastError || routeError || routeEnforceError);
  if (typeof reEnabled === "boolean") routeEnforcementEnabled = reEnabled;

  renderProcessor(processor || data?.processor, effectivePollMs);

  renderSecurityTelemetry(
    security || data?.securityTelemetry,
    floodGuard,
  );

  renderMocaPath(mocaPath || data?.mocaPath, accessPath, mocaTrack || data?.mocaTrack);

  renderNetworkHealth(
    networkHealth || data?.networkHealth,
    networkHealthSummary || data?.networkHealthSummary,
    networkHealthProbing,
    networkHealthError,
  );

  if (!data) return;

  if (profile) {
    activeProfile = profile;
    els.policyStatus.textContent = `Profile: ${profile}`;
    setProfileButtonActive(profile);
    renderCompetitivePanel(profile, policy || competitivePolicy, pSummary, {
      syncForm: false,
      preserveLocalEdits: competitiveDirty,
    });
  }

  const xbox = data.xbox || {};
  const sample = data.sample || {};
  const windowSec = sample.windowSec || 3;

  els.title.textContent = `${xbox.name || "Xbox"} Traffic Monitor`;
  const ipLine = [xbox.ip, xbox.ipv6].filter(Boolean).join(" · ");
  els.subtitle.textContent = `${ipLine || "?"} · ${data.timestamp || "—"}`;

  if (xbox.online) {
    els.onlinePill.textContent = "Online";
    els.onlinePill.className = "status-pill online";
  } else {
    els.onlinePill.textContent = "Offline";
    els.onlinePill.className = "status-pill offline";
  }

  const downKbps = Number(formatKbps(sample.bytesIn, windowSec));
  const upKbps = Number(formatKbps(sample.bytesOut, windowSec));

  renderThroughputDetails(sample, windowSec);
  els.metricPkts.textContent = String(sample.packets ?? 0);
  els.metricConns.textContent = String(data.connections?.count ?? 0);

  const lat = data.wan?.latencyMs;
  els.metricLatency.innerHTML =
    lat == null ? "— <small>ms</small>" : `${lat.toFixed(1)} <small>ms</small>`;

  const gamingMode = data.sqm?.gamingMode || "off";
  const gamingOn = gamingMode === "on" || gamingMode === "partial";
  const gamingDetail = data.sqm?.gamingModeDetail || "";
  els.metricGaming.textContent = gamingOn
    ? gamingMode === "partial"
      ? "PARTIAL"
      : "ON"
    : "OFF";
  if (gamingDetail) {
    els.metricGaming.title = gamingDetail;
  }

  els.deviceMeta.innerHTML = [
    `<strong>${xbox.name || "Xbox"}</strong>`,
    `IPv4: ${xbox.ip || "—"}`,
    `IPv6: ${xbox.ipv6 || "—"}`,
    `MAC: ${xbox.mac || "—"}`,
    `ARP: ${xbox.arpMac || "—"} (${xbox.arpState || "?"})`,
  ].join("<br>");

  els.sqmMeta.innerHTML = [
    `Upload: ${data.sqm?.uploadQdisc || "—"}`,
    `Download: ${data.sqm?.downloadQdisc || "—"}`,
    `Gaming QoS: ${gamingOn ? gamingMode.toUpperCase() : "OFF"}${gamingDetail ? ` (${gamingDetail})` : ""}`,
  ].join("<br>");

  renderRouteAnalysis(data.routeAnalysis, routeProbing, routeEnforcementEnabled);
  renderAiInsights(data.aiInsights);

  const flows = data.topFlows || [];
  els.flowsBody.innerHTML = flows.length
    ? flows
        .map(
          (f) => `<tr>
            <td class="dir-${f.direction}">${f.direction.toUpperCase()}</td>
            <td>${formatEndpoint(f)}</td>
            <td>${formatLatency(f.latencyMs)}</td>
            <td>${f.bytes}</td>
          </tr>`,
        )
        .join("")
    : "<tr><td colspan=\"4\">No packets in sample window</td></tr>";

  const destinations = data.destinations || [];
  els.destinationsBody.innerHTML = destinations.length
    ? destinations
        .map(
          (d) => `<tr>
            <td><span class="kind-${d.kind}">${kindLabel(d.kind)}</span></td>
            <td>${formatRole(d)}</td>
            <td>${formatEndpoint(d)}${d.ip ? `<br><span class="muted-ip">${d.ip}</span>` : ""}</td>
            <td>${formatTier(d)}</td>
            <td>${formatLatency(d.latencyMs)}</td>
            <td>${formatRouteCell(d)}</td>
            <td>${d.port || "—"}</td>
          </tr>`,
        )
        .join("")
    : "<tr><td colspan=\"7\">No destinations yet — launch a game to populate live servers.</td></tr>";

  const conns = data.connections?.items || [];
  const wanConns = conns.filter((c) => c.scope === "wan");
  const displayConns = wanConns.length ? wanConns : conns;
  els.connsBody.innerHTML = displayConns.length
    ? displayConns
        .map(
          (c) => `<tr>
            <td>${c.proto}</td>
            <td>${c.state || "—"}</td>
            <td class="dir-${c.direction || "out"}">${(c.direction || "?").toUpperCase()}</td>
            <td>${formatRole(c)} ${formatEndpoint(c)}</td>
            <td>${c.port || "—"}</td>
            <td>${formatLatency(c.latencyMs)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="6">No active connections — Xbox is idle or in standby.<br><span style="color:var(--muted)">See <strong>Connecting to</strong> above for recent DNS targets.</span></td></tr>`;

  const recent = data.recentFlows || [];
  els.recentBody.innerHTML = recent.length
    ? recent
        .map(
          (f) => `<tr>
            <td class="dir-${f.direction}">${f.direction.toUpperCase()}</td>
            <td>${formatEndpoint(f)}</td>
            <td>${formatBytes(f.upload)}</td>
            <td>${formatBytes(f.download)}</td>
          </tr>`,
        )
        .join("")
    : "<tr><td colspan=\"4\">No recent flows recorded</td></tr>";

  history.push({
    downKbps,
    upKbps,
    downBytes: Number(sample.bytesIn) || 0,
    upBytes: Number(sample.bytesOut) || 0,
    windowSec,
    ts: Date.now(),
  });
  if (history.length > MAX_POINTS) history.shift();
  renderChart();

  els.footer.textContent = `Updated ${new Date().toLocaleTimeString()} · sample ${windowSec}s window`;
}

function connectStream() {
  const source = new EventSource("/api/stream");
  source.onmessage = (event) => {
    try {
      renderSnapshot(JSON.parse(event.data));
    } catch (err) {
      setError(String(err));
    }
  };
  source.onerror = () => {
    setError("Lost connection to monitor — retrying…");
    source.close();
    setTimeout(connectStream, 3000);
  };
}

connectStream();

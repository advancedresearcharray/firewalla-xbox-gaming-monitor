const history = [];
const MAX_POINTS = 60;

const els = {
  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  onlinePill: document.getElementById("online-pill"),
  errorBanner: document.getElementById("error-banner"),
  metricDown: document.getElementById("metric-down"),
  metricUp: document.getElementById("metric-up"),
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
  dnsEnabled: document.getElementById("dns-enabled"),
  dnsFields: document.getElementById("dns-fields"),
  dnsPrimary: document.getElementById("dns-primary"),
  dnsSecondary: document.getElementById("dns-secondary"),
  dnsStatus: document.getElementById("dns-status"),
  applyCompetitiveBtn: document.getElementById("apply-competitive-btn"),
  routeProbeBtn: document.getElementById("route-probe-btn"),
  networkHealthBtn: document.getElementById("network-health-btn"),
  networkHealthStatus: document.getElementById("network-health-status"),
  nhNatType: document.getElementById("nh-nat-type"),
  nhNatDetail: document.getElementById("nh-nat-detail"),
  nhWanTopology: document.getElementById("nh-wan-topology"),
  nhWanDetail: document.getElementById("nh-wan-detail"),
  nhLowestMtu: document.getElementById("nh-lowest-mtu"),
  nhMtuDetail: document.getElementById("nh-mtu-detail"),
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
};

const ctx = els.chart.getContext("2d");

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
  bandwidth: { mode: "dynamic", uploadMbps: 10, downloadMbps: 50 },
  dns: { enabled: false, primary: "1.1.1.1", secondary: "1.0.0.1" },
};
let routeEnforcementEnabled = true;

function syncCompetitiveFormFromPolicy(policy) {
  if (!policy) return;
  competitivePolicy = {
    bandwidth: { ...competitivePolicy.bandwidth, ...policy.bandwidth },
    dns: { ...competitivePolicy.dns, ...policy.dns },
  };
  els.bwUpload.value = competitivePolicy.bandwidth.uploadMbps ?? 10;
  els.bwDownload.value = competitivePolicy.bandwidth.downloadMbps ?? 50;
  els.dnsEnabled.checked = Boolean(competitivePolicy.dns.enabled);
  els.dnsPrimary.value = competitivePolicy.dns.primary || "1.1.1.1";
  els.dnsSecondary.value = competitivePolicy.dns.secondary || "1.0.0.1";
}

function renderCompetitivePanel(profile, policy, summary, options = {}) {
  const syncForm = options.syncForm !== false;
  const show = profile === "competitive";
  els.competitivePanel.hidden = !show;
  if (!show) return;

  if (policy && syncForm) {
    syncCompetitiveFormFromPolicy(policy);
  }

  const bwMode = competitivePolicy.bandwidth?.mode || "dynamic";
  document.querySelectorAll("[data-bw-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bwMode === bwMode);
  });
  els.bandwidthStaticFields.hidden = bwMode !== "static";
  els.dnsFields.hidden = !els.dnsEnabled.checked;

  if (summary) {
    els.bandwidthStatus.textContent = `Bandwidth: ${summary.bandwidth}`;
    els.dnsStatus.textContent = `DNS: ${summary.dns}`;
  }
}

document.querySelectorAll("[data-bw-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    competitivePolicy.bandwidth.mode = btn.dataset.bwMode;
    renderCompetitivePanel("competitive", competitivePolicy);
  });
});

els.dnsEnabled?.addEventListener("change", () => {
  els.dnsFields.hidden = !els.dnsEnabled.checked;
});

async function applyCompetitiveSettings() {
  els.applyCompetitiveBtn.disabled = true;
  els.bandwidthStatus.textContent = "Applying…";
  try {
    const body = {
      bandwidth: {
        mode: competitivePolicy.bandwidth.mode,
        uploadMbps: Number(els.bwUpload.value) || 10,
        downloadMbps: Number(els.bwDownload.value) || 50,
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
      document.querySelectorAll(".policy-btn[data-profile]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.profile === activeProfile);
      });
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
    els.aiPhase.innerHTML = `<span class="ai-phase-pill">${(phase.phase || phase).replace(/-/g, " ")}</span> ${phase.detail || ""}`;
  }
  const status = ai.status || ai.advisor;
  if (status) {
    els.aiStatus.textContent = "Local advisor — heuristics + learning (no cloud API)";
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
    ? recs.map((r) => {
        const cls = r.priority === "high" ? "route-rec route-rec-high" : r.priority === "medium" ? "route-rec route-rec-med" : "route-rec";
        return `<div class="${cls}"><strong>${r.title}</strong><br><span class="muted-ip">${r.detail}</span></div>`;
      }).join("")
    : "";
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
    document.querySelectorAll(".policy-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.profile === profile);
    });
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

function natClass(natType) {
  if (natType === "open") return "nh-nat-open";
  if (natType === "moderate") return "nh-nat-moderate";
  if (natType === "strict") return "nh-nat-strict";
  return "nh-nat-unknown";
}

function renderNetworkHealth(health, summary, probing, error) {
  if (probing) {
    els.networkHealthStatus.textContent = "Probing NAT type and path MTU (may take ~30s)…";
    return;
  }
  if (error) {
    els.networkHealthStatus.textContent = `Network health error: ${error}`;
  } else if (health?.probedAt) {
    els.networkHealthStatus.textContent = `Last probe ${new Date(health.probedAt).toLocaleString()} — NAT & MTU from Firewalla`;
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

  const issues = [...(nat.issues || [])];
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
  const w = els.chart.width;
  const h = els.chart.height;
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) return;

  const max = Math.max(
    ...history.flatMap((p) => [p.downKbps, p.upKbps, 1]),
  );
  const pad = 24;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  ctx.strokeStyle = "#243044";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad + (innerH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
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
  } = payload;
  setError(lastError || routeError || routeEnforceError);
  if (typeof reEnabled === "boolean") routeEnforcementEnabled = reEnabled;

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
    document.querySelectorAll(".policy-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.profile === profile);
    });
    renderCompetitivePanel(profile, policy || competitivePolicy, pSummary, { syncForm: false });
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

  els.metricDown.innerHTML = `${downKbps.toFixed(1)} <small>Kbps</small>`;
  els.metricUp.innerHTML = `${upKbps.toFixed(1)} <small>Kbps</small>`;
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

  history.push({ downKbps, upKbps, ts: Date.now() });
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

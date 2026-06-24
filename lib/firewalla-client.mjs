const DEFAULT_TIMEOUT_MS = 30000;

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function apiFetch(baseUrl, token, path, { method = "GET", body = null } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body != null) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(joinUrl(baseUrl, path), {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`invalid JSON from Firewalla API (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(data.error || `Firewalla API ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function createFirewallaClient(baseUrl, token = "") {
  if (!baseUrl) {
    throw new Error("FIREWALLA_API_URL is required");
  }
  if (!token) {
    throw new Error("FIREWALLA_API_TOKEN is required");
  }

  async function runScript(script, args = [], { sudo = false, payload = null } = {}) {
    const data = await apiFetch(baseUrl, token, "/api/v1/run", {
      method: "POST",
      body: { script, args, sudo, payload },
    });
    if (!data.ok) throw new Error(data.error || "run failed");
    return data.stdout;
  }

  async function runWithPayload(payload, followScript, followArgs = [], { sudo = false } = {}) {
    const args = followArgs.map((arg) => (arg === "@payload" ? "@payload" : arg));
    return runScript(followScript, args, { sudo, payload });
  }

  async function systemProbe() {
    const data = await apiFetch(baseUrl, token, "/api/v1/system");
    return data.stdout;
  }

  async function health() {
    return apiFetch(baseUrl, token, "/api/health");
  }

  async function mobile(name) {
    const data = await apiFetch(baseUrl, token, `/api/v1/mobile/${encodeURIComponent(name)}`);
    return data.result?.data ?? data.result ?? data;
  }

  async function netbot(mtype, data = {}, target = null) {
    const body = { mtype, data };
    if (target) body.target = target;
    const payload = await apiFetch(baseUrl, token, "/api/v1/netbot", {
      method: "POST",
      body,
    });
    return payload.result;
  }

  return { runScript, runWithPayload, systemProbe, health, mobile, netbot };
}

export function scriptBasename(fullPath) {
  const idx = fullPath.lastIndexOf("/");
  return idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
}

/**
 * Load-aware processor scheduler for the dashboard ↔ Firewalla control plane.
 * Defers heavy probes when Firewalla load is high (complements gaming-processor-tune.sh).
 */

const DEFAULT_CORES = 4;

export function parseLoadAvg(text) {
  const parts = (text || "").trim().split(/\s+/);
  if (parts.length < 3) return null;
  return {
    load1: Number(parts[0]),
    load5: Number(parts[1]),
    load15: Number(parts[2]),
    raw: text.trim(),
  };
}

export function normalizedLoad(load1, cores = DEFAULT_CORES) {
  const c = Number(cores) || DEFAULT_CORES;
  return (Number(load1) || 0) / c;
}

export function adaptivePollMs(baseMs, load1, cores = DEFAULT_CORES) {
  const base = Number(baseMs) || 8000;
  const norm = normalizedLoad(load1, cores);
  if (norm >= 1.75) return Math.min(base * 4, 60000);
  if (norm >= 1.25) return Math.min(base * 2, 30000);
  if (norm >= 0.9) return Math.min(Math.round(base * 1.25), 20000);
  return base;
}

export function deferHeavyWork(load1, cores = DEFAULT_CORES) {
  return normalizedLoad(load1, cores) >= 1.2;
}

export function processorHealth(load, memAvailableMb) {
  if (!load) return { status: "unknown", detail: "no load sample" };
  const norm = normalizedLoad(load.load1);
  const memLow = memAvailableMb != null && memAvailableMb < 400;
  if (norm >= 1.5 || memLow) {
    return {
      status: "stressed",
      detail: `load1=${load.load1} (norm ${norm.toFixed(2)})${memLow ? ", low memory" : ""}`,
      norm,
    };
  }
  if (norm >= 1.0) {
    return { status: "busy", detail: `load1=${load.load1}`, norm };
  }
  return { status: "ok", detail: `load1=${load.load1}`, norm };
}

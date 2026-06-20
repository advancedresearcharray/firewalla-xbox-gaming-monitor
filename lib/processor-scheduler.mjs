/**
 * Load- and memory-aware processor scheduler for the dashboard ↔ Firewalla control plane.
 * Defers heavy probes when Firewalla load or free RAM is stressed.
 */

import { memoryPressureTier } from "./memory-pressure.mjs";

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

export function adaptivePollMs(baseMs, load1, cores = DEFAULT_CORES, memAvailableMb = null) {
  const base = Number(baseMs) || 8000;
  const tier = memoryPressureTier(memAvailableMb);
  let ms = base;
  const norm = normalizedLoad(load1, cores);
  if (norm >= 1.75) ms = Math.min(base * 4, 60000);
  else if (norm >= 1.25) ms = Math.min(base * 2, 30000);
  else if (norm >= 0.9) ms = Math.min(Math.round(base * 1.25), 20000);

  if (tier === "critical") ms = Math.max(ms, Math.min(base * 4, 60000));
  else if (tier === "degraded") ms = Math.max(ms, Math.min(base * 2, 30000));

  return ms;
}

export function deferHeavyWork(load1, cores = DEFAULT_CORES, memAvailableMb = null) {
  const tier = memoryPressureTier(memAvailableMb);
  if (tier === "critical" || tier === "degraded") return true;
  return normalizedLoad(load1, cores) >= 1.2;
}

export function processorHealth(load, memAvailableMb) {
  if (!load) return { status: "unknown", detail: "no load sample" };
  const norm = normalizedLoad(load.load1);
  const tier = memoryPressureTier(memAvailableMb);
  const memLow = tier === "critical" || tier === "degraded";
  if (norm >= 1.5 || memLow) {
    return {
      status: "stressed",
      detail: `load1=${load.load1} (norm ${norm.toFixed(2)})${memLow ? `, memory ${tier} (${memAvailableMb ?? "?"} MB free)` : ""}`,
      norm,
      memoryPressure: tier,
    };
  }
  if (norm >= 1.0) {
    return { status: "busy", detail: `load1=${load.load1}`, norm, memoryPressure: tier };
  }
  return { status: "ok", detail: `load1=${load.load1}`, norm, memoryPressure: tier };
}

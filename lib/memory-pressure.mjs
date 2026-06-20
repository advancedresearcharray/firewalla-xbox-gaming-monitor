/**
 * Memory-pressure tiers for Firewalla snapshot pre-abstraction.
 * Dashboard reads MemAvailable and selects on-box collect/fold/wire mode.
 */

export const MEM_OK_MB = 512;
export const MEM_DEGRADED_MB = 400;

export function memoryPressureTier(memAvailableMb) {
  if (memAvailableMb == null || !Number.isFinite(memAvailableMb)) return "unknown";
  if (memAvailableMb < MEM_DEGRADED_MB) return "critical";
  if (memAvailableMb < MEM_OK_MB) return "degraded";
  return "ok";
}

/** Args for gaming-snapshot.sh: always --wire; add --minimal / --critical when pressured. */
export function snapshotArgsForPressure(tier, xboxIp) {
  const args = [xboxIp, "--wire"];
  if (tier === "critical") args.push("--critical");
  else if (tier === "degraded") args.push("--minimal");
  return args;
}

export function snapshotModeLabel(tier) {
  if (tier === "critical") return "critical (folded, no gzip)";
  if (tier === "degraded") return "minimal (folded)";
  if (tier === "ok") return "normal";
  return "unknown";
}

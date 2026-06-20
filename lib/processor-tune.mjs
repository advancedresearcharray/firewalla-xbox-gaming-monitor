/**
 * Processor abstraction layer — maps Zenodo folding/compression theory to
 * monitor control-plane behavior (telemetry folding, payload compression, load scheduling).
 *
 * References:
 * - 10.5281/zenodo.18453148 — effective throughput, preservation ratio, folding pipeline
 * - 10.5281/zenodo.18102374 — 8196D→32D dimensional folding / SVD preservation
 * - 10.5281/zenodo.18079453 — bit-level (zlib) payload compression
 * - 10.5281/zenodo.18728103 — container memory/CPU/storage compression deployment guide
 */

import {
  compressPayload,
  effectiveThroughput,
  foldRouteProbes,
} from "./folding-pipeline.mjs";
import { memoryPressureTier, snapshotModeLabel } from "./memory-pressure.mjs";
import {
  adaptivePollMs,
  deferHeavyWork,
  parseLoadAvg,
  processorHealth,
} from "./processor-scheduler.mjs";

export const ZENODO_REFERENCES = [
  {
    doi: "10.5281/zenodo.18453148",
    title: "Network Throughput via Dimensional Folding and Bit-Level Compression",
    url: "https://zenodo.org/records/18453148",
  },
  {
    doi: "10.5281/zenodo.18102374",
    title: "Optimal 8196D→32D Dimensional Folding",
    url: "https://zenodo.org/records/18102374",
  },
  {
    doi: "10.5281/zenodo.18079453",
    title: "Ultra-High Compression Technology (pattern + folding)",
    url: "https://zenodo.org/records/18079453",
  },
  {
    doi: "10.5281/zenodo.17444522",
    title: "Computational Applications of Derived Category Equivalence",
    url: "https://zenodo.org/records/17444522",
  },
  {
    doi: "10.5281/zenodo.18728103",
    title: "CPU, Memory & Storage Compression Implementation Guide v2",
    url: "https://zenodo.org/records/18728103",
  },
];

const MIN_COMPRESS_BYTES = 128;
const MIN_COMPRESS_GAIN = 1.08;

export function enrichRouteWithFolding(routeData) {
  if (!routeData?.routes?.length) return null;
  return foldRouteProbes(routeData.routes, 32);
}

export function buildProcessorTelemetry({
  loadRaw,
  memAvailableMb,
  basePollMs,
  cores = 4,
  routeData,
  snapshot,
  wireStats = null,
}) {
  const load = parseLoadAvg(loadRaw);
  const health = processorHealth(load, memAvailableMb);
  const memoryPressure = memoryPressureTier(memAvailableMb);
  const pollMs = adaptivePollMs(basePollMs, load?.load1, cores, memAvailableMb);
  const deferHeavy = deferHeavyWork(load?.load1, cores, memAvailableMb);
  const folding = enrichRouteWithFolding(routeData);
  const physicalDown =
    snapshot?.bandwidth?.xboxDownKbps ??
    snapshot?.qos?.xboxDownloadKbps ??
    snapshot?.devices?.[0]?.downloadKbps ??
    null;
  const effectiveDown =
    physicalDown != null
      ? effectiveThroughput(physicalDown, folding?.compressionRatio || 1)
      : null;

  const wireRatio = wireStats?.compressionRatio ?? 1;
  const controlPlaneKbps =
    physicalDown != null
      ? effectiveThroughput(physicalDown, wireRatio * (folding?.compressionRatio || 1))
      : null;

  return {
    references: ZENODO_REFERENCES,
    load,
    memAvailableMb: memAvailableMb ?? null,
    memoryPressure,
    snapshotMode: snapshotModeLabel(memoryPressure),
    health,
    pollMs,
    basePollMs,
    deferHeavyProbes: deferHeavy,
    folding,
    wire: wireStats || null,
    throughput: {
      physicalDownKbps: physicalDown,
      effectiveDownKbps: effectiveDown,
      foldingCompressionRatio: folding?.compressionRatio ?? 1,
      wireCompressionRatio: wireRatio,
      effectiveControlPlaneKbps: controlPlaneKbps,
    },
    sampledAt: Date.now(),
  };
}

/** Ship JSON to Firewalla — gzip when it beats plain size (bit-level compression). */
export function encodeRemotePayload(data) {
  const json = JSON.stringify(data);
  const raw = Buffer.from(json, "utf8");
  const plainB64 = raw.toString("base64");
  const packed = compressPayload(json);
  const useGzip =
    raw.length >= MIN_COMPRESS_BYTES &&
    packed.compressionRatio >= MIN_COMPRESS_GAIN;
  if (!useGzip) {
    return {
      mode: "plain-base64",
      compressionRatio: 1,
      rawBytes: raw.length,
      compressedBytes: raw.length,
      payload: plainB64,
      shellWrite: (tmp) => `echo '${plainB64}' | base64 -d > ${tmp}`,
      shellWriteStdin: (tmp) => ({
        cmd: `base64 -d > ${tmp}`,
        stdin: `${plainB64}\n`,
      }),
    };
  }
  return {
    mode: "gzip-base64",
    compressionRatio: packed.compressionRatio,
    rawBytes: packed.rawBytes,
    compressedBytes: packed.compressedBytes,
    payload: packed.payload,
    shellWrite: (tmp) =>
      `echo '${packed.payload}' | base64 -d | gzip -dc > ${tmp}`,
    shellWriteStdin: (tmp) => ({
      cmd: `base64 -d | gzip -dc > ${tmp}`,
      stdin: `${packed.payload}\n`,
    }),
  };
}

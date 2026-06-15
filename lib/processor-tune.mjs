/**
 * Processor abstraction layer — maps Zenodo folding/compression theory to
 * monitor control-plane behavior (telemetry folding, payload compression, load scheduling).
 *
 * References:
 * - 10.5281/zenodo.18453148 — effective throughput, preservation ratio, folding pipeline
 * - 10.5281/zenodo.18102374 — 8196D→32D dimensional folding / SVD preservation
 * - 10.5281/zenodo.18079453 — bit-level (zlib) payload compression
 * - 10.5281/zenodo.17444522 — equivalence-class grouping for policy reduction
 */

import {
  compressPayload,
  effectiveThroughput,
  foldRouteProbes,
} from "./folding-pipeline.mjs";
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
];

const COMPRESS_THRESHOLD_BYTES = 2048;

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
}) {
  const load = parseLoadAvg(loadRaw);
  const health = processorHealth(load, memAvailableMb);
  const pollMs = adaptivePollMs(basePollMs, load?.load1, cores);
  const deferHeavy = deferHeavyWork(load?.load1, cores);
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

  return {
    references: ZENODO_REFERENCES,
    load,
    memAvailableMb: memAvailableMb ?? null,
    health,
    pollMs,
    basePollMs,
    deferHeavyProbes: deferHeavy,
    folding,
    throughput: {
      physicalDownKbps: physicalDown,
      effectiveDownKbps: effectiveDown,
      foldingCompressionRatio: folding?.compressionRatio ?? 1,
    },
    sampledAt: Date.now(),
  };
}

/** Ship JSON to Firewalla — gzip when payload exceeds threshold (bit-level compression). */
export function encodeRemotePayload(data) {
  const json = JSON.stringify(data);
  if (json.length < COMPRESS_THRESHOLD_BYTES) {
    return {
      mode: "plain-base64",
      compressionRatio: 1,
      shellWrite: (tmp) =>
        `echo '${Buffer.from(json).toString("base64")}' | base64 -d > ${tmp}`,
    };
  }
  const packed = compressPayload(json);
  return {
    mode: "gzip-base64",
    compressionRatio: packed.compressionRatio,
    rawBytes: packed.rawBytes,
    compressedBytes: packed.compressedBytes,
    shellWrite: (tmp) =>
      `echo '${packed.payload}' | base64 -d | gzip -dc > ${tmp}`,
  };
}

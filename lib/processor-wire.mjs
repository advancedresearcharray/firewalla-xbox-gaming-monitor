/**
 * Processor wire format — fold telemetry, compress payloads, decode inbound streams.
 * Creates compact representations for API transport and learning cache (18453148 / 18079453).
 */

import {
  compressPayload,
  decompressPayload,
  effectiveThroughput,
  foldRouteProbes,
} from "./folding-pipeline.mjs";

const WIRE_PREFIX = "GZ1:";
const FOLD_PREFIX = "FLD1:";

/** Expand on-box preabstract folded rows into dashboard-friendly snapshot fields. */
export function normalizePreabstractSnapshot(snapshot) {
  if (!snapshot?.preabstract?.folded) return snapshot;
  const out = { ...snapshot };
  const connFold = snapshot.connections?.folded;
  if (connFold?.length && !snapshot.connections?.items?.length) {
    out.connections = {
      ...snapshot.connections,
      items: connFold.map((row) => ({
        ip: row[0] || "",
        label: row[1] || "",
        proto: row[2] || "",
        state: row[3] || "",
        latencyMs: row[4] ?? null,
      })),
    };
  }
  const destFold = snapshot.destinationsFolded;
  if (destFold?.length && !snapshot.destinations?.length) {
    out.destinations = destFold.map((row) => ({
      ip: row[0] || "",
      label: row[1] || "",
      kind: row[2] || "active",
      latencyMs: row[3] ?? null,
    }));
  }
  return out;
}

/** Trim snapshot to fold-friendly features (8196D→32D style reduction on lists). */
export function foldSnapshot(snapshot) {
  if (!snapshot) return null;
  const destinations = (snapshot.destinations || []).slice(0, 32).map((d) => [
    d.ip || d.hostname || "",
    d.roleId || d.role || "",
    Number(d.bytes || 0),
    Number(d.packets || 0),
    Number(d.latencyMs ?? -1),
  ]);
  const connections = (snapshot.connections?.items || []).slice(0, 32).map((c) => [
    c.ip || c.remote || "",
    c.roleId || "",
    Number(c.bytes || 0),
  ]);
  return {
    timestamp: snapshot.timestamp,
    xbox: {
      ip: snapshot.xbox?.ip,
      online: snapshot.xbox?.online,
      mac: snapshot.xbox?.mac,
    },
    sample: snapshot.sample,
    wan: snapshot.wan,
    sqm: snapshot.sqm,
    connections: {
      count: snapshot.connections?.count ?? connections.length,
      folded: connections,
    },
    destinationsFolded: destinations,
  };
}

/** Create folded + compressed processor wire blob from live telemetry. */
export function createProcessorWire(snapshot, routeData = null) {
  const folded = foldSnapshot(snapshot);
  const routeFold = routeData?.routes?.length
    ? foldRouteProbes(routeData.routes, 32)
    : null;
  const body = {
    v: 1,
    folded,
    routeFold,
    createdAt: Date.now(),
  };
  const json = JSON.stringify(body);
  const packed = compressPayload(json);
  return {
    body,
    encoding: packed.encoding,
    rawBytes: packed.rawBytes,
    compressedBytes: packed.compressedBytes,
    compressionRatio: packed.compressionRatio,
    payload: packed.payload,
    preservation: routeFold?.preservation ?? null,
    effectiveControlKbps: (rawKbps) =>
      rawKbps != null ? effectiveThroughput(rawKbps, packed.compressionRatio) : null,
  };
}

export function decodeProcessorWire(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error("empty processor wire");
  }
  if (trimmed.startsWith(FOLD_PREFIX)) {
    const json = trimmed.slice(FOLD_PREFIX.length);
    const rawBytes = Buffer.byteLength(json, "utf8");
    const parsed = normalizePreabstractSnapshot(JSON.parse(json));
    return {
      json,
      snapshot: parsed,
      mode: "folded-plain",
      stats: {
        rawBytes,
        wireBytes: FOLD_PREFIX.length + rawBytes,
        compressionRatio: 1,
      },
    };
  }
  if (trimmed.startsWith(WIRE_PREFIX)) {
    const b64 = trimmed.slice(WIRE_PREFIX.length);
    const json = decompressPayload(b64);
    const rawBytes = Buffer.byteLength(json, "utf8");
    const compressedBytes = Buffer.byteLength(b64, "utf8");
    return {
      json,
      snapshot: normalizePreabstractSnapshot(JSON.parse(json)),
      mode: "gzip-base64",
      stats: {
        rawBytes,
        wireBytes: WIRE_PREFIX.length + compressedBytes,
        compressionRatio: rawBytes / Math.max(compressedBytes, 1),
      },
    };
  }
  const rawBytes = Buffer.byteLength(trimmed, "utf8");
  return {
    json: trimmed,
    snapshot: normalizePreabstractSnapshot(JSON.parse(trimmed)),
    mode: "plain-json",
    stats: {
      rawBytes,
      wireBytes: rawBytes,
      compressionRatio: 1,
    },
  };
}

export function wireStatsSummary(stats, wire = null) {
  if (!stats) return null;
  return {
    mode: stats.mode || wire?.mode,
    rawBytes: stats.rawBytes,
    wireBytes: stats.wireBytes,
    compressionRatio: Number((stats.compressionRatio || 1).toFixed(2)),
    savedBytes: Math.max(0, (stats.rawBytes || 0) - (stats.wireBytes || 0)),
  };
}

/**
 * Client for Array Folding Compression Engine (guide §8.3 / Zenodo 18728103).
 * Fold-on-ingest for learning caches and large JSON blobs inside the dashboard LXC.
 */

const DEFAULT_URL = process.env.ARRAY_COMPRESSION_URL || "http://127.0.0.1:8200";
const TIMEOUT_MS = Number(process.env.ARRAY_COMPRESSION_TIMEOUT_MS || 15000);

async function postJson(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DEFAULT_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function compressionHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DEFAULT_URL.replace(/\/$/, "")}/`, {
      signal: controller.signal,
    });
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Guide §5.3 — compress JSON on ingest instead of holding full representation on disk. */
export async function compressJsonOnIngest(obj) {
  const text = JSON.stringify(obj);
  const payload = Buffer.from(text, "utf8").toString("base64");
  const result = await postJson("/compress", { payload, encoding: "base64" });
  return {
    _compressed: true,
    encoding: result.encoding,
    payload: result.payload,
    originalBytes: result.original_bytes,
    compressedBytes: result.compressed_bytes,
    ratio: result.ratio,
  };
}

export async function decompressJsonEnvelope(envelope) {
  if (!envelope?._compressed) return envelope;
  const result = await postJson("/decompress", {
    payload: envelope.payload,
    encoding: "base64",
  });
  return JSON.parse(Buffer.from(result.payload, "base64").toString("utf8"));
}

/** Fold connection/latency feature rows (768D-style wide rows → 16D) per guide §5. */
export async function foldVectors(vectors, sourceDims = 768, targetDims = 16) {
  return postJson("/compress/vectors", {
    vectors,
    source_dims: sourceDims,
    target_dims: targetDims,
    precision_bits: 16,
  });
}

export async function estimateMemorySavings(vectorCount, sourceDims = 768, targetDims = 16) {
  return postJson("/estimate", {
    vector_count: vectorCount,
    source_dims: sourceDims,
    target_dims: targetDims,
    precision_bits: 16,
  });
}

/** Transparent gzip proxy for raw wire payloads (guide §8.3 /proxy). */
export async function proxyCompress(rawBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DEFAULT_URL.replace(/\/$/, "")}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: rawBytes,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      compressed: buf,
      originalBytes: Number(res.headers.get("X-Original-Bytes") || 0),
      compressedBytes: Number(res.headers.get("X-Compressed-Bytes") || buf.length),
      ratio: Number(res.headers.get("X-Compression-Ratio") || 1),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function compressionEnabled() {
  return Boolean(process.env.ARRAY_COMPRESSION_URL || process.env.ARRAY_COMPRESSION_ENABLE === "1");
}

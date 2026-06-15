/**
 * Folding pipeline abstraction — inspired by Kilpatrick (2025–2026):
 * - SVD / preservation ratio: 10.5281/zenodo.18453148, 10.5281/zenodo.18102374
 * - Bit-level payload compression (zlib): 10.5281/zenodo.18079453
 * - Policy equivalence grouping: 10.5281/zenodo.17444522
 *
 * Applied to monitor telemetry (not live packet rewriting on Firewalla).
 */

import { gzipSync, gunzipSync } from "node:zlib";

const DEFAULT_FOLD_DIM = 32;

/** σ_min / σ_max — preservation ratio from SVD (paper § preservation ratio). */
export function preservationRatio(matrix) {
  const s = singularValues(matrix);
  if (!s.length || s[0] === 0) return 1;
  return s[s.length - 1] / s[0];
}

/** Effective throughput metric: physical × compression ratio (paper Eq. effective throughput). */
export function effectiveThroughput(physicalKbps, compressionRatio) {
  const physical = Number(physicalKbps) || 0;
  const ratio = Number(compressionRatio) || 1;
  return physical * ratio;
}

/** Fold a list of numeric feature rows to at most `targetDim` principal components. */
export function foldFeatures(rows, targetDim = DEFAULT_FOLD_DIM) {
  if (!rows?.length) return { folded: [], compressionRatio: 1, preservation: 1 };
  const m = rows.length;
  const n = rows[0]?.length || 0;
  if (!n) return { folded: [], compressionRatio: 1, preservation: 1 };

  if (m <= targetDim && n <= targetDim) {
    return {
      folded: rows,
      compressionRatio: 1,
      preservation: preservationRatio(rows),
      method: "identity",
    };
  }

  const mean = Array(n).fill(0);
  for (const row of rows) {
    for (let j = 0; j < n; j++) mean[j] += row[j] / m;
  }
  const centered = rows.map((row) => row.map((v, j) => v - mean[j]));
  const cov = covariance(centered);
  const { vectors, values } = eigenSymmetric(cov);
  const k = Math.min(targetDim, vectors.length, m);
  const components = vectors.slice(0, k);
  const folded = centered.map((row) =>
    components.map((vec) => dot(row, vec)),
  );
  const energy = values.reduce((a, b) => a + b, 0) || 1;
  const kept = values.slice(0, k).reduce((a, b) => a + b, 0);
  return {
    folded,
    compressionRatio: (m * n) / Math.max(folded.length * k, 1),
    preservation: kept / energy,
    method: `pca-${k}d`,
    singularValues: values.slice(0, k),
  };
}

/** Group route rows by equivalent latency band (derived-category style equivalence). */
export function equivalenceClasses(items, keyFn, toleranceMs = 8) {
  const classes = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (key == null || Number.isNaN(key)) continue;
    let found = false;
    for (const cls of classes) {
      if (Math.abs(cls.representative - key) <= toleranceMs) {
        cls.members.push(item);
        found = true;
        break;
      }
    }
    if (!found) {
      classes.push({ representative: key, members: [item] });
    }
  }
  return classes;
}

export function foldRouteProbes(routes, targetDim = DEFAULT_FOLD_DIM) {
  const rows = (routes || [])
    .filter((r) => r.pingMs != null)
    .map((r) => [
      Number(r.pingMs),
      Number(r.hopCount ?? 0),
      Number(r.score ?? 0),
    ]);
  const fold = foldFeatures(rows, targetDim);
  const classes = equivalenceClasses(
    routes?.filter((r) => r.pingMs != null),
    (r) => Number(r.pingMs),
  );
  return {
    ...fold,
    equivalenceClassCount: classes.length,
    topClass: classes[0] || null,
  };
}

export function compressPayload(text) {
  const raw = Buffer.from(text, "utf8");
  const compressed = gzipSync(raw, { level: 6 });
  return {
    encoding: "gzip+base64",
    rawBytes: raw.length,
    compressedBytes: compressed.length,
    compressionRatio: raw.length / Math.max(compressed.length, 1),
    payload: compressed.toString("base64"),
  };
}

export function decompressPayload(base64) {
  return gunzipSync(Buffer.from(base64, "base64")).toString("utf8");
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function covariance(rows) {
  const m = rows.length;
  const n = rows[0]?.length || 0;
  const cov = Array.from({ length: n }, () => Array(n).fill(0));
  if (m < 2) return cov;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (const row of rows) s += row[i] * row[j];
      const v = s / (m - 1);
      cov[i][j] = v;
      cov[j][i] = v;
    }
  }
  return cov;
}

function eigenSymmetric(matrix, maxIter = 48) {
  const n = matrix.length;
  const a = matrix.map((row) => row.slice());
  const v = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let iter = 0; iter < maxIter; iter++) {
    let p = 0;
    let q = 1;
    let max = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(a[i][j]) > max) {
          max = Math.abs(a[i][j]);
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-10) break;
    const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p][q] = a[q][p] = 0;
    for (let i = 0; i < n; i++) {
      if (i === p || i === q) continue;
      const aip = a[i][p];
      const aiq = a[i][q];
      a[i][p] = a[p][i] = c * aip - s * aiq;
      a[i][q] = a[q][i] = s * aip + c * aiq;
    }
    for (let i = 0; i < n; i++) {
      const vip = v[i][p];
      const viq = v[i][q];
      v[i][p] = c * vip - s * viq;
      v[i][q] = s * vip + c * viq;
    }
  }
  const values = Array.from({ length: n }, (_, i) => a[i][i]);
  const order = values
    .map((val, idx) => ({ val, idx }))
    .sort((x, y) => y.val - x.val);
  return {
    values: order.map((o) => o.val),
    vectors: order.map((o) => v.map((row) => row[o.idx])),
  };
}

function singularValues(matrix) {
  const m = matrix.length;
  const n = matrix[0]?.length || 0;
  if (!m || !n) return [];
  const ata =
    n <= m
      ? multiply(transpose(matrix), matrix)
      : multiply(matrix, transpose(matrix));
  return eigenSymmetric(ata).values.map((v) => Math.sqrt(Math.max(v, 0))).sort((a, b) => b - a);
}

function transpose(matrix) {
  const rows = matrix.length;
  const cols = matrix[0]?.length || 0;
  return Array.from({ length: cols }, (_, j) => matrix.map((row) => row[j]));
}

function multiply(a, b) {
  const rows = a.length;
  const cols = b[0]?.length || 0;
  const inner = b.length;
  const out = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      for (let j = 0; j < cols; j++) out[i][j] += a[i][k] * b[k][j];
    }
  }
  return out;
}

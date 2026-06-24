#!/usr/bin/env python3
"""
Array Folding Compression Engine — FastAPI service (guide §8).
Uses arrayfolding SDK when installed; NumPy fold + gzip fallback otherwise.
"""
from __future__ import annotations

import base64
import gzip
import json
import os
import time
import zlib
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field

app = FastAPI(title="array-compression", version="1.0.0")

STATS: dict[str, Any] = {
    "startedAt": time.time(),
    "compressCalls": 0,
    "decompressCalls": 0,
    "vectorCalls": 0,
    "proxyBytesIn": 0,
    "proxyBytesOut": 0,
    "engine": "fallback",
}

_af = None


def _load_sdk():
    global _af
    if _af is not None:
        return _af
    key = os.environ.get("ARRAY_LICENSE_KEY", "")
    try:
        import arrayfolding as af  # type: ignore

        if key:
            af.activate(key)
        _af = af
        STATS["engine"] = "arrayfolding"
        return af
    except Exception:
        STATS["engine"] = "numpy-fallback"
        return None


def _fold_batch(data: np.ndarray, source_dims: int, target_dims: int) -> np.ndarray:
    af = _load_sdk()
    if af is not None:
        return np.asarray(af.batch_fold(data, source_dims=source_dims, target_dims=target_dims))
    if data.ndim != 2 or data.shape[1] != source_dims:
        raise ValueError(f"expected shape (N, {source_dims})")
    n, d = data.shape
    k = min(target_dims, n, d)
    centered = data - data.mean(axis=0)
    cov = centered.T @ centered / max(n - 1, 1)
    vals, vecs = np.linalg.eigh(cov)
    order = np.argsort(vals)[::-1][:k]
    components = vecs[:, order].T
    return centered @ components.T


def _compress_vectors_fallback(
    data: np.ndarray, source_dims: int, target_dims: int, precision_bits: int = 16
) -> dict[str, Any]:
    folded = _fold_batch(data, source_dims, target_dims)
    original_bytes = int(data.nbytes)
    if precision_bits == 16:
        vmin, vmax = float(folded.min()), float(folded.max())
        scale = 65535.0 / max(vmax - vmin, 1e-15)
        quantized = ((folded - vmin) * scale).astype(np.uint16)
        meta = {"vmin": vmin, "vmax": vmax, "dtype": "uint16"}
        payload = quantized.tobytes()
    else:
        meta = {"dtype": "float64"}
        payload = folded.astype(np.float64).tobytes()
    compressed = gzip.compress(payload, compresslevel=6)
    header = json.dumps(
        {
            "v": 1,
            "engine": STATS["engine"],
            "source_dims": source_dims,
            "target_dims": target_dims,
            "shape": list(folded.shape),
            "meta": meta,
        }
    ).encode("utf-8")
    blob = len(header).to_bytes(4, "big") + header + compressed
    return {
        "compressed": base64.b64encode(blob).decode("ascii"),
        "original_bytes": original_bytes,
        "compressed_bytes": len(blob),
        "total_ratio": original_bytes / max(len(blob), 1),
        "folded_shape": list(folded.shape),
    }


class B64Payload(BaseModel):
    payload: str
    encoding: str = "base64"


class VectorCompressRequest(BaseModel):
    vectors: list[list[float]]
    source_dims: int = Field(default=768, ge=2, le=8196)
    target_dims: int = Field(default=16, ge=2, le=256)
    precision_bits: int = Field(default=16, ge=8, le=32)


class EstimateRequest(BaseModel):
    vector_count: int = Field(default=1_000_000, ge=1)
    source_dims: int = Field(default=768, ge=2, le=8196)
    target_dims: int = Field(default=16, ge=2, le=256)
    precision_bits: int = Field(default=16, ge=8, le=32)


@app.on_event("startup")
def startup():
    _load_sdk()


@app.get("/")
def health():
    return {
        "ok": True,
        "service": "array-compression",
        "engine": STATS["engine"],
        "stats": STATS,
        "guide": "10.5281/zenodo.18728103",
    }


@app.post("/compress")
def compress_body(body: B64Payload):
    STATS["compressCalls"] += 1
    raw = base64.b64decode(body.payload)
    compressed = gzip.compress(raw, compresslevel=6)
    out = base64.b64encode(compressed).decode("ascii")
    return {
        "payload": out,
        "encoding": "gzip+base64",
        "original_bytes": len(raw),
        "compressed_bytes": len(compressed),
        "ratio": len(raw) / max(len(compressed), 1),
    }


@app.post("/decompress")
def decompress_body(body: B64Payload):
    STATS["decompressCalls"] += 1
    raw = gzip.decompress(base64.b64decode(body.payload))
    return {
        "payload": base64.b64encode(raw).decode("ascii"),
        "encoding": "base64",
        "bytes": len(raw),
    }


@app.post("/compress/vectors")
def compress_vectors(req: VectorCompressRequest):
    STATS["vectorCalls"] += 1
    if not req.vectors:
        raise HTTPException(400, "vectors required")
    data = np.asarray(req.vectors, dtype=np.float64)
    if data.ndim != 2 or data.shape[1] != req.source_dims:
        raise HTTPException(
            400,
            f"expected vectors with {req.source_dims} dimensions per row",
        )
    af = _load_sdk()
    if af is not None and hasattr(af, "compress_vectors"):
        try:
            result = af.compress_vectors(
                data,
                source_dims=req.source_dims,
                target_dims=req.target_dims,
                precision_bits=req.precision_bits,
            )
            if isinstance(result.get("compressed"), (bytes, bytearray)):
                result["compressed"] = base64.b64encode(result["compressed"]).decode("ascii")
            return result
        except Exception as exc:
            STATS["lastSdkError"] = str(exc)
    return _compress_vectors_fallback(
        data, req.source_dims, req.target_dims, req.precision_bits
    )


@app.post("/estimate")
def estimate(req: EstimateRequest):
    original = req.vector_count * req.source_dims * 8
    folded = req.vector_count * req.target_dims * 8
    quant = req.vector_count * req.target_dims * (req.precision_bits // 8)
    compressed = int(quant * 0.55)
    return {
        "vector_count": req.vector_count,
        "source_dims": req.source_dims,
        "target_dims": req.target_dims,
        "original_bytes": original,
        "fold_only_bytes": folded,
        "fold_quant_bytes": quant,
        "estimated_compressed_bytes": compressed,
        "fold_ratio": original / max(folded, 1),
        "full_pipeline_ratio": original / max(compressed, 1),
        "engine": STATS["engine"],
    }


@app.post("/proxy")
async def proxy(request: Request):
    raw = await request.body()
    STATS["proxyBytesIn"] += len(raw)
    STATS["compressCalls"] += 1
    compressed = gzip.compress(raw, compresslevel=6)
    STATS["proxyBytesOut"] += len(compressed)
    return Response(
        content=compressed,
        media_type="application/octet-stream",
        headers={
            "X-Original-Bytes": str(len(raw)),
            "X-Compressed-Bytes": str(len(compressed)),
            "X-Compression-Ratio": f"{len(raw) / max(len(compressed), 1):.2f}",
            "Content-Encoding": "gzip",
        },
    )

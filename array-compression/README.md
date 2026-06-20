# Array Folding Compression Engine (container service)

Implements [CPU, Memory & Storage Compression Implementation Guide v2](../docs/cpu_memory_storage_compression_guide_v2.pdf) (Zenodo [10.5281/zenodo.18728103](https://doi.org/10.5281/zenodo.18728103)).

Runs **inside the dashboard LXC only** — not on Firewalla host.

## Install SDK (inside container)

```bash
mkdir -p /opt/arrayfolding
# Push from host after trial download:
#   pct push 933 arrayfolding-1.0.0-py3-none-any.whl /opt/arrayfolding/
#   pct push 933 libarray_core.so /opt/arrayfolding/
pip install /opt/arrayfolding/arrayfolding-1.0.0-py3-none-any.whl --break-system-packages
export ARRAY_LICENSE_KEY="ARRAY-XXXXX-..."
export ARRAY_NATIVE_LIB=/opt/arrayfolding/libarray_core.so
```

Without the SDK wheel, the service uses a NumPy fold + gzip fallback (same API surface).

## Deploy

```bash
./scripts/deploy-array-compression.sh
```

Service listens on `0.0.0.0:8200` inside CT933.

## API (guide §8.3)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health + cumulative stats |
| POST | `/compress` | Compress base64 payload |
| POST | `/decompress` | Decompress payload |
| POST | `/compress/vectors` | Fold + quantize + compress |
| POST | `/estimate` | Estimate savings |
| POST | `/proxy` | Raw bytes in, compressed out |

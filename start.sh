#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

: "${HOST:=0.0.0.0}"
: "${PORT:=8787}"
: "${DATA_DIR:=$ROOT/data}"
: "${RUST_LOG:=failover_proxy=info,tower_http=info}"
export HOST PORT DATA_DIR RUST_LOG

needs_build=0
if [ ! -x "$ROOT/target/release/failover-proxy" ]; then
  needs_build=1
elif find "$ROOT/src" "$ROOT/assets" "$ROOT/Cargo.toml" "$ROOT/Cargo.lock" -type f -newer "$ROOT/target/release/failover-proxy" | grep -q .; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  echo "Building Failover Proxy release binary..."
  cargo build --release --offline
fi

echo "Failover Proxy will listen on http://$HOST:$PORT"
echo "Admin UI: http://127.0.0.1:$PORT"
echo "Data dir: $DATA_DIR"

exec "$ROOT/target/release/failover-proxy" --host "$HOST" --port "$PORT" --data-dir "$DATA_DIR"

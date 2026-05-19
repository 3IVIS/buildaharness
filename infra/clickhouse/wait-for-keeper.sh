#!/bin/sh
# wait-for-keeper.sh — wraps the ClickHouse entrypoint and waits for the
# built-in Keeper to be ready before the container reports healthy.
#
# The standard healthcheck (SELECT 1) passes as soon as the TCP server starts,
# but Keeper takes an additional 10-30 seconds to elect a leader and start
# serving. Langfuse's ReplicatedMergeTree migrations hang indefinitely if they
# reach Keeper before it's ready.
#
# This script is run as the ClickHouse CMD — it starts the server in the
# background, waits for Keeper on port 9181, then keeps the server in the
# foreground.

set -e

# Start ClickHouse server in background
/entrypoint.sh &
CH_PID=$!

echo "[wait-for-keeper] ClickHouse starting (pid $CH_PID)..."

# Wait for the TCP server to accept connections first
until clickhouse-client --query "SELECT 1" >/dev/null 2>&1; do
  echo "[wait-for-keeper] Waiting for ClickHouse TCP server..."
  sleep 2
done
echo "[wait-for-keeper] ClickHouse TCP server is up."

# Now wait for Keeper port 9181
echo "[wait-for-keeper] Waiting for built-in Keeper on port 9181..."
KEEPER_READY=0
for i in $(seq 1 60); do
  if clickhouse-client --query "SELECT count() FROM system.clusters WHERE cluster='default'" 2>/dev/null | grep -q "^1"; then
    KEEPER_READY=1
    break
  fi
  sleep 2
done

if [ "$KEEPER_READY" = "1" ]; then
  echo "[wait-for-keeper] Keeper is ready — cluster 'default' is visible."
else
  echo "[wait-for-keeper] WARNING: Keeper did not become ready in 120s — continuing anyway."
fi

# Keep the server process in foreground
wait $CH_PID

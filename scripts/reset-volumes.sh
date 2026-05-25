#!/usr/bin/env bash
# reset-volumes.sh
#
# Use this when Postgres rejects the password in your .env — usually because:
#   • You changed POSTGRES_PASSWORD after the volume was first created, OR
#   • You're running docker compose up on a machine that already has a
#     postgres_data volume from a previous project install.
#
# This script stops all containers, removes the three persistent data volumes
# (postgres_data, redis_data, clickhouse_data), and lets Docker Compose
# reinitialise them cleanly on the next `docker compose up`.
#
# ⚠️  ALL DATA IN THOSE VOLUMES WILL BE LOST.
#     Back up any flows you care about first via the Flows API or export button.

set -euo pipefail

echo ""
echo "⚠️  This will permanently delete all itsharness data volumes:"
echo "   postgres_data  (flows, jobs, teams, orgs)"
echo "   redis_data     (JWT blocklist)"
echo "   clickhouse_data (Langfuse traces)"
echo ""
read -rp "Type 'yes' to continue, anything else to cancel: " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Stopping all containers..."
docker compose down --timeout 10

echo "Removing data volumes..."
docker volume rm \
  itsharness_postgres_data \
  itsharness_redis_data \
  itsharness_clickhouse_data \
  2>/dev/null && echo "Volumes removed." || echo "Some volumes not found (already gone)."

echo ""
echo "Done. Run 'docker compose up' to start fresh."
echo "Langfuse and the adapter will re-initialise their schemas automatically."

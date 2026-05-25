# Troubleshooting

## Postgres authentication failure on `docker compose up`

**Symptom**

```
postgres-1  | FATAL: password authentication failed for user "itsharness"
langfuse-1  | Error: P1000 — Authentication failed against database server
langfuse-1 exited with code 1 (restarting)
```

**Cause**

Postgres stores the `itsharness` user's password inside the data volume when the container is first initialised. If `POSTGRES_PASSWORD` in your `.env` no longer matches the password baked into the volume — because you changed it, or because you're running on a machine that already had a `postgres_data` volume from an earlier run — Postgres rejects every connection.

The `postgres-init.sql` script only runs when the data directory is **empty** (first boot). It does not run again on subsequent starts.

**Fix**

Back up any flows you want to keep (export them via the canvas export button or `GET /flows`), then reset the volumes:

```bash
./scripts/reset-volumes.sh
```

This stops all containers and removes the three data volumes (`postgres_data`, `redis_data`, `clickhouse_data`). On the next `docker compose up`, Postgres initialises fresh with the password currently in your `.env`.

> If you don't have the script: `docker compose down && docker volume rm itsharness_postgres_data itsharness_redis_data itsharness_clickhouse_data && docker compose up`

---

## `REDIS_PASSWORD variable is not set` warning

**Symptom**

```
WARN[0000] The "REDIS_PASSWORD" variable is not set. Defaulting to a blank string.
```

Followed shortly by Redis authentication errors in the adapter or Langfuse logs.

**Cause**

`REDIS_PASSWORD` is missing from your `.env` file. Docker Compose passes it to `redis-server --requirepass` and to all consumers. Without it, Redis starts without auth enforcement but the consumers (which construct `redis://:@redis:6379/1`) still send an empty password — and depending on Redis version this either works silently or fails.

**Fix**

Add `REDIS_PASSWORD` to your `.env`:

```bash
echo "REDIS_PASSWORD=$(openssl rand -base64 24)" >> .env
```

Then restart:

```bash
docker compose down && docker compose up
```

If the Redis volume already has data from a password-less run, you may also need to remove it:

```bash
docker volume rm itsharness_redis_data
```

---

## Canvas not reachable (`http://localhost:3000`)

**Symptom:** Browser shows connection refused or blank page.

Check that the `canvas` service started:

```bash
docker compose ps
docker compose logs canvas
```

Common causes:
- `npm run build` failed during the canvas container build — check for TypeScript errors in the build log
- Port 3000 already in use — `lsof -i :3000`

---

## Adapter health check failing

```bash
curl http://localhost:8000/health
```

If this returns an error or times out:

```bash
docker compose logs adapter --tail 50
```

Common causes:
- Alembic migration failed (Postgres not ready yet, or migration error) — look for `alembic upgrade head` in the logs
- A required secret is missing or still at its placeholder value — the adapter logs `FATAL: required secrets missing or insecure` and exits immediately
- Postgres or Redis not healthy yet — the adapter has `depends_on: condition: service_healthy` but health checks can still race on slow machines; try `docker compose up` again

---

## Langfuse UI not loading (`http://localhost:3001`)

Langfuse depends on Postgres, Redis, and ClickHouse all being healthy before it starts migrations. On slow machines or first boot it can take 30–60 seconds.

```bash
docker compose logs langfuse --tail 30
docker compose logs langfuse-worker --tail 30
```

If Langfuse keeps restarting with a Prisma error, check that the `langfuse` database exists in Postgres. It is created by `infra/postgres-init.sql` — which only runs on first boot. If you wiped the Postgres volume and recreated it, the database should be re-created automatically.

To verify manually:

```bash
docker compose exec postgres psql -U itsharness -c '\l'
```

You should see databases: `itsharness`, `langfuse`, `litellm`. If `langfuse` is missing, run:

```bash
docker compose exec postgres psql -U itsharness \
  -c "CREATE DATABASE langfuse OWNER itsharness;"
```

---

## ClickHouse Keeper not ready

**Symptom:** `[wait-for-keeper] Waiting for built-in Keeper on port 9181...` loops indefinitely.

ClickHouse Keeper (the embedded ZooKeeper replacement) can take 10–20 seconds on first start. Wait for it. If it never becomes ready:

```bash
docker compose logs clickhouse --tail 50
```

If the data directory is corrupted (can happen after an unclean shutdown), reset the volume:

```bash
docker compose down
docker volume rm itsharness_clickhouse_data
docker compose up
```

---

## `mastra-runner` lockfile missing

**Symptom:** Docker build for `mastra-runner` fails with `npm ci` error about missing `package-lock.json`.

```bash
cd mastra-runner && npm install && cd ..
docker compose build mastra-runner
```

This is a one-time step. Commit `mastra-runner/package-lock.json` so teammates don't need to repeat it.

---

## Password contains special characters

If any secret (especially `POSTGRES_PASSWORD`) contains characters like `@`, `/`, `+`, or `=`, the URL-encoded connection strings in `docker-compose.yml` may break.

The safest passwords use only alphanumeric characters. Generate with:

```bash
openssl rand -base64 32 | tr -d '=+/'    # alphanumeric only
```

---

## Resetting everything

To wipe all state and start completely fresh:

```bash
docker compose down --volumes --remove-orphans
docker compose up
```

`--volumes` removes all named volumes. The next `docker compose up` reinitialises everything from scratch.

---

## Langfuse `ENCRYPTION_KEY must be 256 bits, 64 string characters in hex format`

**Symptom**

```
langfuse-1 | ZodError: ENCRYPTION_KEY must be 256 bits, 64 string characters in hex format,
            | generate via: openssl rand -hex 32
```

**Cause**

`LANGFUSE_ENCRYPTION_KEY` is missing from `.env`, is still at a placeholder value, or was generated with the wrong command. This key must be **exactly 64 lowercase hex characters** — the output of `openssl rand -hex 32`. Using `openssl rand -base64 32` (which generates ~44 base64 characters) will fail this check.

**Fix**

```bash
echo "LANGFUSE_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
docker compose down && docker compose up
```

Verify the value is correct before restarting:

```bash
grep LANGFUSE_ENCRYPTION_KEY .env | awk -F= '{print length($2), $2}'
# Should print: 64 <64-char-hex-string>
```

---

## Multiple secrets missing at once

If you're hitting one secret error after another on each restart, the fastest path is to verify all required secrets are set and non-placeholder before starting. Run this check against your `.env`:

```bash
python3 - << 'EOF'
import re

required = [
    "JWT_SECRET", "POSTGRES_PASSWORD", "REDIS_PASSWORD",
    "LITELLM_MASTER_KEY", "LANGFUSE_ADMIN_EMAIL", "LANGFUSE_ADMIN_PASSWORD",
    "LANGFUSE_NEXTAUTH_SECRET", "LANGFUSE_SALT", "LANGFUSE_ENCRYPTION_KEY",
    "CLICKHOUSE_PASSWORD",
]
placeholders = {"REPLACE_ME", "REPLACE_WITH_REAL_SECRET", "REPLACE_WITH_REAL_PASSWORD",
                "your_password", "changeme", ""}

env = {}
with open(".env") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()

all_ok = True
for key in required:
    val = env.get(key, "")
    missing = not val or val in placeholders or "REPLACE" in val
    if missing:
        print(f"  ❌ {key}: {'not set' if not val else 'still a placeholder'}")
        all_ok = False
    else:
        print(f"  ✅ {key}")

# Special check: LANGFUSE_ENCRYPTION_KEY must be exactly 64 hex chars
enc = env.get("LANGFUSE_ENCRYPTION_KEY", "")
if enc and (len(enc) != 64 or not re.fullmatch(r"[0-9a-fA-F]+", enc)):
    print(f"  ❌ LANGFUSE_ENCRYPTION_KEY: wrong format — must be 64 hex chars (openssl rand -hex 32)")
    all_ok = False

if all_ok:
    print("\nAll required secrets look good.")
else:
    print("\nFix the above before running docker compose up.")

---

## Langfuse `ENCRYPTION_KEY must be 256 bits, 64 string characters in hex format`

**Symptom**

```
langfuse-1 | ZodError: ENCRYPTION_KEY must be 256 bits, 64 string characters in hex format,
            | generate via: openssl rand -hex 32
```

**Cause**

`LANGFUSE_ENCRYPTION_KEY` is missing from `.env`, still at a placeholder, or was generated with the wrong command. It must be **exactly 64 lowercase hex characters** — the output of `openssl rand -hex 32`. Using `openssl rand -base64 32` (~44 base64 characters) fails this check.

**Fix**

```bash
echo "LANGFUSE_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
docker compose down && docker compose up
```

Verify the value before restarting:

```bash
grep LANGFUSE_ENCRYPTION_KEY .env | awk -F= '{print length($2), $2}'
# Should print: 64 <64-char-hex-string>
```

---

## Multiple secrets missing at once

If you are hitting one secret error after another on each restart, verify all required secrets are set before starting again. Run from the project root:

```bash
bash scripts/check-env.sh
```

Or, if you want the same logic inline:

```python
import re

required = [
    "JWT_SECRET", "POSTGRES_PASSWORD", "REDIS_PASSWORD",
    "LITELLM_MASTER_KEY", "LANGFUSE_ADMIN_EMAIL", "LANGFUSE_ADMIN_PASSWORD",
    "LANGFUSE_NEXTAUTH_SECRET", "LANGFUSE_SALT", "LANGFUSE_ENCRYPTION_KEY",
    "CLICKHOUSE_PASSWORD",
]
placeholders = {"REPLACE_ME", "REPLACE_WITH_REAL_SECRET", "REPLACE_WITH_REAL_PASSWORD",
                "your_password", "changeme", ""}

env = {}
with open(".env") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()

all_ok = True
for key in required:
    val = env.get(key, "")
    bad = not val or val in placeholders or "REPLACE" in val
    print(f"  {'❌' if bad else '✅'} {key}" + (" — not set or placeholder" if bad else ""))
    if bad:
        all_ok = False

# LANGFUSE_ENCRYPTION_KEY must be exactly 64 hex chars
enc = env.get("LANGFUSE_ENCRYPTION_KEY", "")
if enc and (len(enc) != 64 or not re.fullmatch(r"[0-9a-fA-F]+", enc)):
    print("  ❌ LANGFUSE_ENCRYPTION_KEY — wrong format (must be 64 hex chars from: openssl rand -hex 32)")
    all_ok = False

print()
print("All secrets OK — ready to start." if all_ok else "Fix the above before running docker compose up.")
```

Run it with `bash scripts/check-env.sh` from the project root.

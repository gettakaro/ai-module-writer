#!/usr/bin/env bash
set -euo pipefail

# CI bootstrap script — spins up the Takaro stack via docker-compose.ci.yml,
# runs migrations, waits for health, creates a test domain, and exports
# environment variables for the test runner.
#
# Exports to $GITHUB_ENV (or to local shell if not in GitHub Actions):
#   TAKARO_HOST
#   TAKARO_WS_URL
#   TAKARO_USERNAME
#   TAKARO_PASSWORD
#   TAKARO_DOMAIN_ID
#   TAKARO_REGISTRATION_TOKEN

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.ci.yml"

# ── Generate random credentials ──────────────────────────────────────────────

if [[ -z "${AWS_ECR_REGISTRY:-}" ]]; then
  echo "ERROR: AWS_ECR_REGISTRY is required but not set." >&2
  exit 1
fi

export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
export POSTGRES_ENCRYPTION_KEY="${POSTGRES_ENCRYPTION_KEY:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
export ADMIN_CLIENT_SECRET="${ADMIN_CLIENT_SECRET:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"
export JWT_SECRET="${JWT_SECRET:-$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)}"

echo "Generated random credentials for CI run."

# ── Helper: wait for HTTP health endpoint ────────────────────────────────────

wait_healthy() {
  local url="$1"
  local max_attempts="${2:-60}"
  local attempt=0

  echo "Waiting for ${url} to be healthy..."
  while true; do
    attempt=$((attempt + 1))
    if curl -sf -o /dev/null "${url}"; then
      echo "  ${url} is healthy."
      return 0
    fi
    if [[ ${attempt} -ge ${max_attempts} ]]; then
      echo "ERROR: ${url} did not become healthy after ${max_attempts} attempts." >&2
      return 1
    fi
    sleep 2
  done
}

# ── Tear down any stale containers first ─────────────────────────────────────

echo "Cleaning up any stale containers..."
docker compose -f "${COMPOSE_FILE}" down --remove-orphans --volumes 2>/dev/null || true

# ── Step 1: Start datastores ─────────────────────────────────────────────────

echo "Starting datastores (postgresql, postgresql_kratos, redis)..."
docker compose -f "${COMPOSE_FILE}" up -d postgresql postgresql_kratos redis mailhog

echo "Waiting for postgres to be ready..."
max_pg_attempts=30
pg_attempt=0
until docker compose -f "${COMPOSE_FILE}" exec postgresql pg_isready -U takaro-ci -d takaro-ci-db >/dev/null 2>&1; do
  pg_attempt=$((pg_attempt + 1))
  if [[ ${pg_attempt} -ge ${max_pg_attempts} ]]; then
    echo "ERROR: PostgreSQL did not become ready after ${max_pg_attempts} attempts." >&2
    exit 1
  fi
  sleep 2
done
echo "  PostgreSQL is ready."

# ── Step 2: Run Kratos SQL migrations ────────────────────────────────────────

echo "Running Kratos SQL migrations..."
docker compose -f "${COMPOSE_FILE}" run --rm kratos-migrate

# ── Step 3: Start Kratos, wait for health ────────────────────────────────────

echo "Starting Kratos..."
docker compose -f "${COMPOSE_FILE}" up -d kratos

wait_healthy "http://localhost:4433/health/ready" 60

# ── Step 4: Run Takaro API DB migrations ─────────────────────────────────────

echo "Running Takaro API DB migrations..."
docker compose -f "${COMPOSE_FILE}" run --rm takaro_api npm -w packages/app-api run db:migrate

echo "Starting takaro_api..."
docker compose -f "${COMPOSE_FILE}" up -d takaro_api

echo "Waiting for takaro_api to be healthy..."
wait_healthy "http://localhost:13000/healthz" 90

# ── Step 5: Start remaining services ─────────────────────────────────────────

echo "Starting connector and mock gameserver..."
docker compose -f "${COMPOSE_FILE}" up -d takaro_connector takaro_mock_gameserver

wait_healthy "http://localhost:3003/healthz" 60
wait_healthy "http://localhost:3002/healthz" 60

# ── Step 6: Create test domain via AdminClient ────────────────────────────────

echo "Creating test domain..."
CRED_OUTPUT=$(
  TAKARO_HOST="http://localhost:13000" \
  ADMIN_CLIENT_SECRET="${ADMIN_CLIENT_SECRET}" \
  node --import=ts-node-maintained/register/esm "${REPO_ROOT}/src/scripts/ci-create-domain.ts"
)

# Parse output into variables — extract only the expected keys explicitly
TAKARO_DOMAIN_ID="$(echo "${CRED_OUTPUT}" | grep '^TAKARO_DOMAIN_ID=' | cut -d= -f2-)"
TAKARO_USERNAME="$(echo "${CRED_OUTPUT}" | grep '^TAKARO_USERNAME=' | cut -d= -f2-)"
TAKARO_PASSWORD="$(echo "${CRED_OUTPUT}" | grep '^TAKARO_PASSWORD=' | cut -d= -f2-)"
TAKARO_REGISTRATION_TOKEN="$(echo "${CRED_OUTPUT}" | grep '^TAKARO_REGISTRATION_TOKEN=' | cut -d= -f2-)"

# Validate that all critical credentials were obtained
if [[ -z "${TAKARO_DOMAIN_ID}" ]]; then
  echo "ERROR: TAKARO_DOMAIN_ID is empty — domain creation may have failed." >&2
  exit 1
fi
if [[ -z "${TAKARO_USERNAME}" ]]; then
  echo "ERROR: TAKARO_USERNAME is empty — domain creation may have failed." >&2
  exit 1
fi
if [[ -z "${TAKARO_PASSWORD}" ]]; then
  echo "ERROR: TAKARO_PASSWORD is empty — domain creation may have failed." >&2
  exit 1
fi
if [[ -z "${TAKARO_REGISTRATION_TOKEN}" ]]; then
  echo "ERROR: TAKARO_REGISTRATION_TOKEN is empty — the domain was created but did not return a registration token. This may indicate an API version mismatch." >&2
  exit 1
fi

echo "Domain created successfully."

# ── Step 7: Export to GitHub Actions env or local shell ───────────────────────

SENSITIVE_KEYS=("TAKARO_PASSWORD" "ADMIN_CLIENT_SECRET" "TAKARO_REGISTRATION_TOKEN")

export_var() {
  local key="$1"
  local value="$2"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    # Mask sensitive values in GitHub Actions log output
    for sensitive_key in "${SENSITIVE_KEYS[@]}"; do
      if [[ "${key}" == "${sensitive_key}" ]]; then
        echo "::add-mask::${value}"
        break
      fi
    done
    echo "${key}=${value}" >> "${GITHUB_ENV}"
  fi
}

export_var "TAKARO_HOST" "http://localhost:13000"
export_var "TAKARO_WS_URL" "ws://localhost:3004"
export_var "TAKARO_DOMAIN_ID" "${TAKARO_DOMAIN_ID}"
export_var "TAKARO_USERNAME" "${TAKARO_USERNAME}"
export_var "TAKARO_PASSWORD" "${TAKARO_PASSWORD}"
export_var "TAKARO_REGISTRATION_TOKEN" "${TAKARO_REGISTRATION_TOKEN}"

echo "Bootstrap complete. Takaro stack is ready."

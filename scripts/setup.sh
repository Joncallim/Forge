#!/usr/bin/env bash
set -euo pipefail

echo "==> Forge setup"

# Check dependencies
for cmd in docker docker-compose; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is not installed" >&2
    exit 1
  fi
done

# Copy env file if not present
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example — fill in your API keys before continuing"
  exit 0
fi

# Start infrastructure
echo "==> Starting Redis and PostgreSQL"
docker compose up -d --wait postgres redis

echo "==> Infrastructure ready"
echo "    PostgreSQL: localhost:5432"
echo "    Redis:      localhost:6379"
echo ""
echo "==> Start the web UI:  cd web && npm run dev"
echo "==> Start the worker:  cd web && npm run worker"

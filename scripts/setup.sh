#!/usr/bin/env bash
set -euo pipefail

# Forge local services setup.
#
# One pass: create .env if needed, start PostgreSQL and Redis with Docker,
# install web dependencies, run database migrations, and seed the agents.
# After this finishes you can go straight to `cd web && npm run dev`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

bold "Forge local services setup"
info "This starts PostgreSQL and Redis and prepares the web app in one pass."

cd "$REPO_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  die "Docker is not installed. Install Docker Desktop or Docker Engine, then run this again."
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "Docker Compose is not available. Install the Docker Compose plugin or docker-compose."
fi

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 20 or newer, then run this again."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $(node -v) is too old. Forge needs Node 20 or newer."
fi

# Create the env file if it does not exist. We do NOT exit afterwards: the rest
# of setup runs in the same pass so there is nothing to re-run by hand.
if [ ! -f .env ]; then
  cp .env.example .env
  step "Created .env"
  info "Defaults target local Docker PostgreSQL and Redis and work as-is."
  info "Provider API keys are optional here — add them later in the Forge web UI."
else
  step "Using existing .env"
fi

# Start infrastructure
step "Starting PostgreSQL and Redis"
info "Docker will download the images the first time. Later runs are much faster."
"${COMPOSE[@]}" up -d --wait postgres redis

step "Infrastructure ready"
info "PostgreSQL: localhost:5432"
info "Redis:      localhost:6379"

# Prepare the web app: install dependencies, migrate the database, seed agents.
step "Installing web dependencies"
info "npm install can take a few minutes on the first run."
(cd web && npm install --loglevel=error --no-audit --no-fund)

step "Applying database migrations"
(cd web && npm run db:migrate)

step "Seeding agent configurations"
(cd web && npm run db:seed-agents)

step "Setup complete"
info "Start Forge with: cd web && npm run dev"
info "Then open http://localhost:3000 and create the first account."
info "The web UI starts the task worker automatically unless FORGE_EMBED_WORKER=0."

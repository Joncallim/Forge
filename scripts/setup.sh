#!/usr/bin/env bash
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

bold "Forge local services setup"
info "This starts PostgreSQL and Redis for local development."

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

# Copy env file if not present
if [ ! -f .env ]; then
  cp .env.example .env
  step "Created .env"
  info "Review .env before continuing. For local Docker, the database and Redis defaults work as-is."
  info "Provider API keys are optional here because you can add them later in the Forge web UI."
  info "Run this script again when you are ready to start PostgreSQL and Redis."
  exit 0
fi

# Start infrastructure
step "Starting PostgreSQL and Redis"
info "Docker will download the images the first time. Later runs are much faster."
"${COMPOSE[@]}" up -d --wait postgres redis

step "Infrastructure ready"
info "PostgreSQL: localhost:5432"
info "Redis:      localhost:6379"
printf '\n'
info "Next: cd web && npm install && npm run db:migrate && npm run db:seed-agents"
info "Then start the web UI: cd web && npm run dev"
info "And in another terminal: cd web && npm run worker"

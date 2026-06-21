# Database Migrations

Forge stores users, sessions, providers, projects, tasks, runs, and artifacts in
PostgreSQL. A database migration is a small SQL file that changes that database
shape over time.

Most people only need one command:

```bash
cd web
npm run db:migrate
```

Run it after pulling new code and before starting Forge.

## When You Change The Database

If you edit [web/db/schema.ts](../web/db/schema.ts), generate a migration before
committing:

```bash
cd web
npm run db:generate -- --name short_change_name
npm run db:migrate
```

Then run the normal checks:

```bash
npm run lint
npm test
npm run build
```

## What The Files Mean

- `web/db/schema.ts` is the TypeScript source of truth for the current schema.
- `web/db/migrations/*.sql` are the SQL steps Drizzle applies in order.
- `web/db/migrations/meta/*.json` are Drizzle's bookkeeping snapshots.
- `web/db/migrations/meta/_journal.json` lists the migrations Drizzle knows
  about.

Do not edit the `meta` JSON files by hand unless you are repairing migration
bookkeeping. Prefer `npm run db:generate`.

## Current Migration History

| Migration | What it does |
|---|---|
| `0000_green_black_queen.sql` | Creates the first Forge tables. |
| `0001_acoustic_triathlon.sql` | Adds encrypted provider API-key storage. |
| `0002_add_password_hash.sql` | Adds password-hash storage for password sign-in. |

## Common Problems

If `db:migrate` cannot connect, check that PostgreSQL is running and that
`DATABASE_URL` points to the right place.

For local Docker:

```bash
bash scripts/setup.sh
cd web
npm run db:migrate
```

For the cross-platform installer:

```bash
bash scripts/install.sh
```

That installer runs migrations for you.

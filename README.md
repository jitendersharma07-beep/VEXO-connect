# VEXO Connect

Multi-tenant point-of-sale platform by ATC Infocom, mounted at
`https://atcworkspace.com/pos`. Fully isolated from ATC NOC/CRM, Megatel,
Google Review Manager and WhatsApp: own repo, own Postgres, own JWT secret,
own compose stacks. The only shared piece is one `location ^~ /pos/` block in
the host nginx.

**VEXO Connect** is the product name — what the screens, the sign-in page and
the client guides say. The repo directory, the containers, the database and the
`/api/atc/*` routes keep their original `atc-pos` / `atc_pos` identifiers on
purpose: renaming those is a migration, not a rebrand. ATC Infocom Solutions
Pvt. Ltd. remains the company behind it, which is why the address is still
`atcworkspace.com`.

## Architecture

- `backend/` — Express 4 + Prisma 5 API (`/api/*`), argon2 passwords, JWT in an
  httpOnly `pos_session` cookie backed by a DB session row (revocable).
- `frontend/` — React 18 + Vite + Tailwind SPA, built with `base=/pos/` for
  production; container nginx serves the SPA and proxies `/api/` to the backend.
- `docker-compose.yml` — dev Postgres only (loopback `5439`, DBs `atc_pos` +
  `atc_pos_test`); backend and frontend run on the host in dev.
- `docker-compose.prod.yml` — `pos-prod` stack: postgres + backend + frontend
  edge on loopback `127.0.0.1:8110`.
- `deploy/go-live-path.sh` — adds the `/pos` route to the atcworkspace.com
  vhost (backup + `nginx -t` + auto-rollback), brings the stack up, verifies.

## Tenancy, roles, licensing

- `Company` → `Branch` → `PosUser`; customer principals are hard-scoped to
  their own company server-side (a client-supplied companyId is ignored).
  Cross-company reads answer 404, indistinguishable from a row that does not
  exist.
- Roles: `POS_SUPER_ADMIN` (VEXO platform), `CUSTOMER_OWNER`,
  `BRANCH_MANAGER`, `CASHIER` (the last two are pinned to one branch).
- Licences: `FREE_TRIAL`, `SINGLE_STORE` (1 branch), `MULTI_STORE`
  (base limit + `ADDITIONAL_BRANCH` add-ons). `EXPIRED` is derived at read
  time, never stored. Expired/suspended licences block writes but leave
  sign-in and reads open. Only the VEXO console (`/api/atc/*`) can change any
  of it.

## Development

```bash
docker compose up -d                  # dev Postgres on 127.0.0.1:5439
cd backend && npm install
export DATABASE_URL='postgresql://atc_pos:atc_pos_dev@127.0.0.1:5439/atc_pos?schema=public'
export POS_JWT_SECRET='dev-only-secret-at-least-32-chars-long'
npx prisma migrate dev                # apply migrations
node prisma/seed.js                   # VEXO admin + demo café (passwords print once)
npm run dev                           # API on :5010

cd ../frontend && npm install
npm run dev                           # SPA on :5177, proxies /api to :5010
```

Tests (they truncate tables, so the DB name must end in `_test`):

```bash
cd backend
DATABASE_URL='postgresql://atc_pos:atc_pos_dev@127.0.0.1:5439/atc_pos_test?schema=public' \
POS_JWT_SECRET='test-secret-0123456789abcdef0123456789' npm test
```

## Production

```bash
cp .env.example .env                  # fill in real values; .env is git-ignored
export GIT_SHA=$(git rev-parse HEAD)  # stamps the images; see "Build provenance"
export BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec backend node prisma/seed.js
sudo bash deploy/go-live-path.sh      # nginx route + verification
```

Seed passwords come from `POS_SEED_*_PASSWORD` env vars or are generated and
printed once — they are never committed or stored in plain text.

### Build provenance

The two `export`s above are what make the built images say which commit they
came from. Skipping them is not an error — the build succeeds and the stamp
reads `unknown`, which is the signal that it was skipped.

Read it back three ways, in increasing order of what has to be working:

```bash
# 1. The image — answers even if the container will not start.
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' pos-prod-backend:latest
docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' pos-prod-frontend:latest

# 2. The process — answers with the database down.
curl -s localhost:${HTTP_PORT:-8110}/api/version

# 3. The full stack, edge through to the database.
curl -s localhost:${HTTP_PORT:-8110}/api/health
```

`/api/version` returns `{ service, version, gitSha, builtAt }` and deliberately
does not touch the database, so it still answers during exactly the kind of
broken deploy that makes you ask the question. `version` comes from
`backend/package.json`, which ships inside the image; `gitSha` and `builtAt`
come from the build args.

Before this existed, identifying the live commit meant git-blob-hashing all 51
backend source files out of the running container — and that still could not
distinguish six commits whose source trees are byte-identical, because they
differ only in documentation.

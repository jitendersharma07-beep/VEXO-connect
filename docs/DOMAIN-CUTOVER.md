# Moving VEXO Connect to vexoconnect.com

Today the product is served at `https://atcworkspace.com/pos`, sharing an origin
with the ATC platform, `/reviews`, `/whatsapp` and `/workspace`. This is the
runbook for giving it its own domain at the root.

Nothing here has been deployed. The branch is `phase2-domain-cutover`.

## The one thing that makes this awkward

**It is a switch, not a parallel run.** Vite inlines the base path into the
bundle at build time, so a single build cannot serve both `/pos` and the root of
a domain. The moment the root-base image is live, the `/pos` mount is broken —
`index.html` asks for `/assets/*`, the host nginx routes that to the ATC
platform app, and the client gets a blank page. There is no window in which both
URLs work, which is why `/pos` has to become a 301 in the same breath.

This is also why the client company should be created *after* the cutover, not
before: onboarding someone onto `/pos` today means re-issuing their URL and
retraining their staff a week later.

## What is already proven

Measured on 2026-09-22 against the deployed stack, not assumed:

- **The code needs no changes.** `api.js` derives its base from
  `import.meta.env.BASE_URL`, `App.jsx` passes the same value as the router
  `basename`, and `frontend/nginx.conf` has no `/pos` in it at all — it already
  serves at `/`. The prefix lives in exactly two places: the host nginx block
  and the bundle's build-time base.
- **A root-base build works end to end.** Built with
  `--build-arg VITE_BASE_PATH=/`, run on the `pos-prod_default` network, it
  scored **8/9** on `prod-verify` — identical to the live `/pos` deployment,
  same single known TTY failure. API proxying, SPA deep-link refresh and bundle
  content all passed at the root.
- **`prod-verify.mjs` now handles both.** It reads the mount from `BASE_URL` and
  the bundle base out of `index.html` instead of hardcoding `/pos`. Re-checked
  at 8/9 on loopback and 8/9 on the public `/pos` mount, so it is correct
  *before* the cutover too. The pre-change version scores **3/9** against a
  working root deployment — five false failures — which is what this would have
  cost on cutover day.
- **Both vhosts pass `nginx -t` together**, validated in a throwaway
  `nginx:alpine` container with dummy certificates. The host's nginx was not
  touched.

## Prerequisites

1. `vexoconnect.com` DNS points at this server.
2. A certificate exists:
   `sudo certbot certonly --nginx -d vexoconnect.com -d www.vexoconnect.com`

`deploy/go-live-domain.sh` checks both and refuses to start if either is
missing, so running it early is free.

## Order of operations

The order matters: the build is slow and harmless, the flip is fast and
breaking. Do the slow part first so the broken window is seconds, not minutes.

1. **Edit `.env`** — three values change together:
   ```
   APP_URL=https://vexoconnect.com
   CORS_ORIGIN=https://vexoconnect.com
   VITE_BASE_PATH=/
   ```
2. **Tag a rollback anchor**, because the current image is about to be replaced:
   ```
   docker image tag pos-prod-frontend:latest pos-prod-frontend:rollback-pre-domain
   ```
3. **Rebuild the frontend.** The running container is unaffected by a build.
   Export the provenance stamp even though only one service is being rebuilt:
   omitting it leaves the frontend labelled `unknown` while the backend still
   carries a real SHA, and a stack that gives two different answers about which
   commit it runs is worse than one that gives none.
   ```
   cd /home/atc-noc/atc-pos
   export GIT_SHA=$(git rev-parse HEAD)
   export BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   docker compose -f docker-compose.prod.yml build frontend
   ```
4. **Flip.** The script writes the new vhost, converts `/pos` to a 301, tests
   nginx, reloads, and recreates the frontend container — in that order.
   ```
   sudo bash /home/atc-noc/atc-pos/deploy/go-live-domain.sh
   ```
   It refuses to proceed unless the built image is genuinely a root-base build
   and `CORS_ORIGIN` already matches, which is the specific mistake — flipping
   nginx while the old bundle is still running — that would otherwise take the
   POS down.
5. **Restart the backend** so the new `CORS_ORIGIN` is live. It is runtime env,
   not build-time:
   ```
   docker compose -f docker-compose.prod.yml up -d --no-deps backend
   ```
6. **Verify by content**, not by status code:
   ```
   BASE_URL=https://vexoconnect.com node deploy/prod-verify.mjs
   ```
   Expect 8/9, with the TTY failure being the only red line.

## After the flip

- **Sign in once and confirm the session sticks.** The `/pos` block carried
  `proxy_cookie_path / /pos/;` because several apps shared that origin. The new
  vhost deliberately omits it. If that line were ever copied across, the
  `pos_session` cookie would be scoped to a path that does not exist and every
  sign-in would appear to succeed and then bounce straight back to `/login`.
- **Sweep the docs.** 19 references to `atcworkspace.com/pos` across
  `README.md`, `docs/guide-owner.md`, `docs/guide-cashier.md`,
  `docs/HANDOVER.md`, `docs/DEPLOY-PHASE2.md`, `docs/BACKUP-RESTORE.md` and
  `docs/RAZORPAY-SANDBOX.md`. They are deliberately left alone on this branch —
  until the cutover actually happens, changing them would make the documents
  lie. The two client guides matter most; they go to the café owner.
- **Then register the Razorpay webhook**, not before. Registering it against
  `atcworkspace.com/pos` first means tearing it down and re-registering, and a
  half-migrated webhook silently drops `payment.captured` events.
- **Only then create the client company**, so the client's first sign-in is
  already on the final URL.

## Rollback

`go-live-domain.sh` backs up both vhosts with a shared timestamp and restores
**both together** if `nginx -t` fails, before anything is reloaded. If the
domain misbehaves after a successful reload, the script prints the exact
restore commands for that run; they amount to putting the old vhost back,
removing the new symlink, reloading, and re-tagging
`pos-prod-frontend:rollback-pre-domain` back to `:latest`.

Note that `/pos` only works again after the old *image* is restored, not just
the old vhost — the two have to go back together for the same reason they had
to change together.

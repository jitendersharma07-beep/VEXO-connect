FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

# Operational scripts (password rotation, etc). The deploy runbook tells the
# operator to run these with `docker exec pos-prod-backend-1 node
# scripts/...`, which fails with MODULE_NOT_FOUND unless they are in the
# image. They are not imported by src/, so nothing at boot notices they are
# missing — the first symptom is the procedure failing when you need it.
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 5000

# Build provenance. Declared last on purpose: the value changes on every commit,
# and anything that consumes an ARG invalidates the cache from that layer down —
# above this line, `npm ci` and `prisma generate` still hit the cache.
#
# Both a label and an env var because they serve different readers. The label is
# readable with `docker inspect` when the container will not start at all, and
# `printenv` inside a live one needs neither the database nor a token — those are
# the channels the deploy runbook uses. The env var is also what the process
# reports over GET /api/version, the only channel open to someone with HTTP to
# the service but no shell on this host; that route is gated at POS_SUPER_ADMIN,
# because the SHA names which published fixes this deploy does not have.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="atc-pos-api" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.created="$BUILD_TIME"
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

CMD ["node", "src/index.js"]

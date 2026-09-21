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

CMD ["node", "src/index.js"]

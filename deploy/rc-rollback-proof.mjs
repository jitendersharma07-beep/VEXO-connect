#!/usr/bin/env node
// Proves the release candidate's migration is safe to roll back from, the way
// production would do it: the previous release's code booting with its real
// command (`npx prisma migrate deploy && node src/index.js`) against a
// database that already carries the candidate's migrations — then rolling
// forward again.
//
//   1. RC      migrates a fresh database, seeds it, takes a card bill and
//              refunds it (method inferred CARD).
//   2. v1.0.1  boots on that database, keeps taking money and refunding
//              (its refunds land with method NULL), and reads the RC's rows.
//   3. RC      boots again: nothing to migrate, and the day close counts the
//              NULL row as cash and the CARD row as not.
//
// Throwaway database atc_pos_rb_<timestamp> on the dev Postgres; drops
// nothing. Usage (on the lab):
//   V101_DIR=~/atc-pos-v101 node deploy/rc-rollback-proof.mjs

import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (os.hostname() === 'atc-noc') {
  console.error('REFUSED: this host runs production');
  process.exit(2);
}
const RC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const V101_DIR = process.env.V101_DIR;
if (!V101_DIR) {
  console.error('V101_DIR must point at a checkout of the previous release with backend deps installed');
  process.exit(2);
}

const RUN = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const DB = `atc_pos_rb_${RUN}`;
const PORT = Number(process.env.RB_PORT || 5012);
const BASE = `http://127.0.0.1:${PORT}/api`;
const hex = (n) => randomBytes(n).toString('hex');

// The dev database password is read from the running container, never stored
// in this repo. Same source as backend/scripts/dev-sandbox-fixture.mjs.
const PW = execFileSync('docker', ['exec', 'atc-pos-dev-db', 'printenv', 'POSTGRES_PASSWORD'])
  .toString()
  .trim();
if (!PW) {
  console.error('FAIL: could not read POSTGRES_PASSWORD from atc-pos-dev-db — is the dev stack up?');
  process.exit(2);
}

const ENV = {
  ...process.env,
  DATABASE_URL: `postgresql://atc_pos:${PW}@127.0.0.1:5439/${DB}?schema=public`,
  POS_JWT_SECRET: hex(32),
  HOST: '127.0.0.1',
  PORT: String(PORT),
  POS_SEED_ADMIN_PASSWORD: hex(12),
  POS_SEED_OWNER_PASSWORD: hex(12),
  POS_SEED_MANAGER_PASSWORD: hex(12),
  POS_SEED_CASHIER_PASSWORD: hex(12),
  POS_SEED_ALLOW_FIXED_PASSWORDS: 'true',
};

const sql = (q) =>
  execFileSync('docker', ['exec', 'atc-pos-dev-db', 'psql', '-U', 'atc_pos', '-d', DB, '-tAc', q], {
    encoding: 'utf8',
  }).trim();

const results = [];
const check = (id, what, pass, detail = '') => {
  results.push({ id, what, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${what}${detail ? `  [${detail}]` : ''}`);
};

const boot = async (label, dir, command) => {
  const log = path.join(RC_DIR, '.devlogs', `rb-${RUN}-${label}.log`);
  const child = spawn('sh', ['-c', command], {
    cwd: path.join(dir, 'backend'),
    env: ENV,
    detached: true,
    stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')],
  });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return { child, log };
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { child, log, failed: true };
};
const stop = async ({ child }) => {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`${BASE}/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
};
const logText = (log) => execFileSync('cat', [log], { encoding: 'utf8' });

const api = async (token, method, p, body) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ownerSession = async () => {
  const r = await api(null, 'POST', '/auth/login', {
    email: 'demo.owner@atcpos.example',
    password: ENV.POS_SEED_OWNER_PASSWORD,
  });
  if (r.status !== 200) throw new Error(`owner login ${r.status}`);
  return r.body.token;
};
const refundedBill = async (token, method, refund) => {
  const branches = (await api(token, 'GET', '/branches')).body.branches;
  const cp = branches.find((b) => b.code === 'BSC-CP');
  const products = (await api(token, 'GET', '/catalog/products')).body.products;
  const espresso = products.find((p) => p.sku === 'ESP-01');
  const o = await api(token, 'POST', '/orders', {
    type: 'TAKEAWAY', branchId: cp.id, items: [{ productId: espresso.id, qty: 1 }],
  });
  const billed = await api(token, 'POST', `/orders/${o.body.order.id}/bill`);
  const total = billed.body.order.total;
  const pay = method === 'CASH'
    ? { method, tendered: total, idempotencyKey: randomUUID() }
    : { method, amount: total, idempotencyKey: randomUUID() };
  const paid = await api(token, 'POST', `/orders/${o.body.order.id}/payments`, pay);
  const r = await api(token, 'POST', `/orders/${o.body.order.id}/refunds`, { amount: refund, reason: 'rollback proof' });
  return { orderId: o.body.order.id, cp, paid: paid.status, refund: r };
};

execFileSync('docker', ['exec', 'atc-pos-dev-db', 'psql', '-U', 'atc_pos', '-d', 'atc_pos', '-qc', `CREATE DATABASE ${DB} OWNER atc_pos`]);
console.log(`database ${DB}, backend 127.0.0.1:${PORT}\n`);
const rcMigrations = execFileSync('ls', [path.join(RC_DIR, 'backend/prisma/migrations')], { encoding: 'utf8' })
  .split('\n').filter((n) => /^\d{14}_/.test(n));
const v101Migrations = execFileSync('ls', [path.join(V101_DIR, 'backend/prisma/migrations')], { encoding: 'utf8' })
  .split('\n').filter((n) => /^\d{14}_/.test(n));
const newOnes = rcMigrations.filter((m) => !v101Migrations.includes(m));
console.log(`RC carries ${rcMigrations.length} migrations; v1.0.1 carries ${v101Migrations.length}; new: ${newOnes.join(', ')}\n`);

// 1 — the candidate migrates and writes a CARD refund.
const rc1 = await boot('rc-1', RC_DIR, 'npx prisma migrate deploy && node prisma/seed.js && node src/index.js');
check('RB-1', 'RC boots on a fresh database and applies every migration', !rc1.failed,
  `${sql("select count(*) from _prisma_migrations where finished_at is not null")} applied`);
let token = await ownerSession();
const card = await refundedBill(token, 'CARD', 20);
check('RB-2', 'RC records a card bill refund with method CARD',
  card.refund.status === 201 && sql(`select method from "Refund" where "orderId" = '${card.orderId}'`) === 'CARD');
await stop(rc1);

// 2 — the previous release boots with production's own command.
const old = await boot('v101', V101_DIR, 'npx prisma migrate deploy && node src/index.js');
const oldLog = logText(old.log);
check('RB-3', "v1.0.1 boots with production's command against the migrated database", !old.failed,
  (oldLog.match(/No pending migrations to apply|following migration|rror[^\n]*/g) || []).join(' | '));
token = await ownerSession();
const readBack = await api(token, 'GET', `/orders/${card.orderId}`);
check('RB-4', "v1.0.1 reads the RC's refunded bill", readBack.status === 200 && readBack.body.order.refunds.length === 1,
  `HTTP ${readBack.status}`);
const cash = await refundedBill(token, 'CASH', 10);
check('RB-5', 'v1.0.1 still takes money and refunds; its refund lands with method NULL',
  cash.paid === 201 && cash.refund.status === 201
    && sql(`select coalesce(method::text,'NULL') from "Refund" where "orderId" = '${cash.orderId}'`) === 'NULL');
const oldPreview = await api(token, 'GET', `/reports/day-close/preview?branchId=${cash.cp.id}`);
check('RB-6', 'v1.0.1 day close still answers (old rule: every manual refund counted as cash)',
  oldPreview.status === 200, `cashRefunds ${oldPreview.body?.preview?.cashRefunds}`);
await stop(old);

// 3 — roll forward again.
const rc2 = await boot('rc-2', RC_DIR, 'npx prisma migrate deploy && node src/index.js');
check('RB-7', 'RC boots again with nothing left to migrate', !rc2.failed && /No pending migrations/.test(logText(rc2.log)));
token = await ownerSession();
const preview = await api(token, 'GET', `/reports/day-close/preview?branchId=${cash.cp.id}`);
check('RB-8', "RC's day close counts v1.0.1's NULL refund as cash and the CARD refund as not",
  preview.status === 200 && Number(preview.body.preview.cashRefunds) === 10,
  `cashRefunds ${preview.body?.preview?.cashRefunds} (card 20 excluded, legacy cash 10 counted)`);
await stop(rc2);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} rollback checks passed.`);
process.exit(failed.length ? 1 : 0);

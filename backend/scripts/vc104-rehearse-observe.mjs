// VC-104 migration rehearsal — measure what the index migration does to writers.
//
// Runs as a sidecar to `prisma migrate deploy`. Two jobs:
//
//   WRITER  a tight INSERT loop on PhoneOrder, the table the migration indexes.
//           Every insert is timed individually, so a write that BLOCKS shows up
//           as one long sample rather than being averaged away. This is the
//           number that matters operationally: "how long was a till stuck".
//   SAMPLER polls pg_locks/pg_stat_activity every 20 ms and records which lock
//           modes the migration actually took, and whether anything waited.
//
// It deliberately does NOT run the migration itself. The caller starts this,
// then runs migrate deploy, then signals completion by creating the stop file.
// Keeping them in separate processes means the writer is a genuinely separate
// session competing for the same locks — running both in one process with one
// pool would let Prisma serialise them and hide the contention.
//
// Refuses to run against anything but a vcx_rehearse_* database.
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';

const stopFile = process.argv[2];
if (!stopFile) {
  console.error('usage: node vc104-rehearse-observe.mjs <stop-file>');
  process.exit(2);
}

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (!/^vcx_rehearse_[a-z0-9_]+$/.test(dbName)) {
  console.error(`REFUSED: ${dbName} is not a vcx_rehearse_* database`);
  process.exit(2);
}

const writer = new PrismaClient();
const sampler = new PrismaClient();

const samples = [];
const lockObs = new Map(); // "mode|relation|granted" -> count
let waited = 0;
let inserts = 0;
let failures = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => !existsSync(stopFile);

const writeLoop = async () => {
  let n = 0;
  while (running()) {
    const id = `rh-probe-${Date.now()}-${n++}`;
    const t = process.hrtime.bigint();
    try {
      await writer.$executeRawUnsafe(`
        INSERT INTO "PhoneOrder"
          (id, "companyId", reference, "customerId", fulfilment, status,
           "routedBranchId", "operatorName", "idempotencyKey", "requestHash",
           "createdAt", "updatedAt")
        VALUES ($1,'rh-co',$1,'rh-cu','DELIVERY','SUBMITTED','rh-b1','probe',$1,$1,now(),now())`,
        id);
      inserts += 1;
    } catch (e) {
      failures.push(String(e.message ?? e).split('\n')[0]);
    }
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    await sleep(2);
  }
};

const sampleLoop = async () => {
  while (running()) {
    try {
      const rows = await sampler.$queryRawUnsafe(`
        SELECT l.mode, l.granted, COALESCE(c.relname, l.locktype) AS rel,
               a.state, left(coalesce(a.query,''), 60) AS q
          FROM pg_locks l
          LEFT JOIN pg_class c ON c.oid = l.relation
          LEFT JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE a.datname = current_database()
           AND a.pid <> pg_backend_pid()
           AND (c.relname IN ('PhoneOrder','PhoneOrderEvent') OR l.granted = false)`);
      for (const r of rows) {
        if (!r.granted) waited += 1;
        const k = `${r.mode}|${r.rel}|${r.granted ? 'granted' : 'WAITING'}`;
        lockObs.set(k, (lockObs.get(k) ?? 0) + 1);
      }
    } catch {
      /* the sampler must never be the reason the rehearsal fails */
    }
    await sleep(20);
  }
};

await Promise.all([writeLoop(), sampleLoop()]);

samples.sort((a, b) => a - b);
const pct = (p) => (samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * p))] : 0);

console.log(`writer inserts     : ${inserts}`);
console.log(`writer failures    : ${failures.length}${failures.length ? ' -> ' + failures[0] : ''}`);
console.log(`insert p50 / p95   : ${pct(0.5).toFixed(1)} ms / ${pct(0.95).toFixed(1)} ms`);
console.log(`insert MAX (stall) : ${pct(1).toFixed(1)} ms`);
console.log(`lock samples seen waiting: ${waited}`);
console.log('lock modes observed on the indexed tables:');
for (const [k, n] of [...lockObs.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}x  ${k}`);
}

await writer.$disconnect();
await sampler.$disconnect();

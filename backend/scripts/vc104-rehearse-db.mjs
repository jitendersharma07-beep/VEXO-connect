// VC-104 migration rehearsal — scratch-database lifecycle helper.
//
// Creates and drops the throwaway database the rehearsal runs against. Kept in
// its own file because CREATE DATABASE / DROP DATABASE cannot run inside a
// transaction, so they need a connection to the `postgres` maintenance database
// rather than to the database being rehearsed, and that is a different client.
//
// This NEVER touches production. The only database name it will accept is one
// matching /^vcx_rehearse_/, checked below, so a mistyped argument fails closed
// instead of dropping something real.
//
// Usage: node scripts/vc104-rehearse-db.mjs <create|drop|recreate> <dbname>
import { PrismaClient } from '@prisma/client';

const [, , action, dbName] = process.argv;

if (!/^vcx_rehearse_[a-z0-9_]+$/.test(dbName ?? '')) {
  console.error(`REFUSED: database name ${JSON.stringify(dbName)} is not vcx_rehearse_*`);
  process.exit(2);
}

const base = new URL(process.env.DATABASE_URL);
const admin = new URL(base.toString());
admin.pathname = '/postgres';

const prisma = new PrismaClient({ datasources: { db: { url: admin.toString() } } });

const drop = async () => {
  // Terminate stragglers first; a lingering session makes DROP DATABASE fail.
  await prisma.$executeRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    dbName,
  );
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  console.log(`dropped ${dbName}`);
};

const create = async () => {
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  console.log(`created ${dbName}`);
};

try {
  if (action === 'drop') await drop();
  else if (action === 'create') await create();
  else if (action === 'recreate') {
    await drop();
    await create();
  } else {
    console.error(`REFUSED: unknown action ${JSON.stringify(action)}`);
    process.exit(2);
  }
} finally {
  await prisma.$disconnect();
}

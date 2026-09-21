// Scoped password-only rotation for named ATC POS accounts.
//
// Why this exists instead of re-running the seed: `prisma/seed.js` is a
// provisioning script — with POS_SEED_RESET_PASSWORDS=true it walks the whole
// foundation (ATC operator + demo company + branches) and will create rows
// that are missing. This script never creates anything and never touches
// licences, catalog, orders, payments or branches: it writes
// PosUser.passwordHash + mustChangePassword for accounts you name explicitly,
// then revokes their live sessions.
//
// Usage (inside the backend container; DATABASE_URL comes from the env):
//   node scripts/rotate-pos-passwords.mjs --emails a@x,b@y            # PREVIEW
//   node scripts/rotate-pos-passwords.mjs --emails a@x,b@y --confirm  # WRITE
//
// Preview is the default: it prints exactly which accounts would change and
// exits 0 without writing. Nothing is written without --confirm.
//
// Password source:
//   default   generate a strong random password per account, printed ONCE.
//   --prompt  read each password from the terminal with echo off (needs a TTY,
//             i.e. `docker exec -it`). Values never appear in argv, in the
//             environment, or in shell history.
//
// Where the generated passwords go:
//   default      stdout, once. Fine at a terminal you control; NOT fine when
//                something else is capturing the scrollback.
//   --out FILE   write them to FILE with mode 0600 and keep stdout free of
//                secrets. Refuses if FILE already exists, so a second run can
//                never silently overwrite credentials you have not read yet.
//
// --demo: leave mustChangePassword = FALSE instead of forcing a change on
// first sign-in. This deliberately disables a security control and exists for
// ONE case: a shared demo credential handed to several people. The forced
// change is non-dismissible in the UI, so the first person to sign in would
// otherwise change the password and lock everybody else out. Never use --demo
// for a real user account — for those, the forced change IS the point.
//
// Exit codes: 0 ok · 1 refused/failed · 2 usage.

import { PrismaClient } from '@prisma/client';
import { hash as argon2Hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const CR = '\r';
const LF = '\n';
const EOT = String.fromCharCode(4); // ctrl-D
const ETX = String.fromCharCode(3); // ctrl-C
const DEL = String.fromCharCode(127);
const BS = String.fromCharCode(8);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const emailsArg = valueOf('--emails') || process.env.POS_ROTATE_EMAILS || '';
const emails = emailsArg
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const confirm = has('--confirm');
const usePrompt = has('--prompt');
const demo = has('--demo');
const outFile = valueOf('--out');

if (!emails.length) {
  console.error(
    'usage: node scripts/rotate-pos-passwords.mjs --emails a@x,b@y [--prompt] [--demo] [--out FILE] [--confirm]',
  );
  process.exit(2);
}
// Gate on the FLAG, not on its value: `--out` as the last argument makes
// valueOf() return undefined, and testing the value alone would let that fall
// through to the default — which prints the passwords to stdout. A typo must
// never downgrade "write to a 0600 file" into "print the secrets".
if (has('--out') && (!outFile || outFile.startsWith('--'))) {
  console.error('refused: --out needs a file path');
  process.exit(2);
}
if (outFile && usePrompt) {
  console.error('refused: --out has nothing to write under --prompt (you chose the passwords yourself)');
  process.exit(2);
}
// Never clobber a credential file that may not have been read yet.
if (outFile && existsSync(outFile)) {
  console.error(`refused: ${outFile} already exists; move or delete it first`);
  process.exit(2);
}
const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
if (dupes.length) {
  console.error(`refused: duplicate emails in the list: ${[...new Set(dupes)].join(', ')}`);
  process.exit(2);
}

const prisma = new PrismaClient();

const readHidden = (prompt) =>
  new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('--prompt needs a TTY (run with `docker exec -it`); refusing to read a password from a pipe'));
      return;
    }
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let buf = '';
    const finish = (fn, arg) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stderr.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === CR || ch === LF || ch === EOT) return finish(resolve, buf);
        if (ch === ETX) return finish(reject, new Error('cancelled at the password prompt'));
        if (ch === DEL || ch === BS) buf = buf.slice(0, -1);
        else buf += ch;
      }
      return undefined;
    };
    process.stdin.on('data', onData);
  });

const main = async () => {
  // 1. Resolve the named accounts and show exactly what is in scope. An email
  //    that does not resolve is a STOP: a typo must never silently rotate a
  //    shorter list than the operator believes.
  const users = await prisma.posUser.findMany({
    where: { email: { in: emails } },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      companyId: true,
      company: { select: { slug: true } },
    },
    orderBy: { email: 'asc' },
  });

  const missing = emails.filter((e) => !users.some((u) => u.email === e));
  if (missing.length) {
    console.error(`refused: these emails have no POS account: ${missing.join(', ')}`);
    console.error('nothing was written.');
    process.exit(1);
  }

  const live = await prisma.posSession.groupBy({
    by: ['userId'],
    where: { userId: { in: users.map((u) => u.id) }, revokedAt: null, expiresAt: { gt: new Date() } },
    _count: { _all: true },
  });
  const liveFor = (id) => live.find((l) => l.userId === id)?._count._all ?? 0;

  console.log('accounts in scope (password + sessions only; licences/catalog/orders untouched):');
  for (const u of users) {
    console.log(
      `  ${u.email}  role=${u.role}  status=${u.status}  company=${u.company ? u.company.slug : 'ATC-operator'}  live-sessions=${liveFor(u.id)}`,
    );
  }

  console.log(
    `\nmode: forced-change=${demo ? 'OFF (--demo, shared demo credential)' : 'ON'}  passwords=${
      usePrompt ? 'typed at the prompt' : outFile ? `written to ${outFile}` : 'printed to stdout once'
    }`,
  );

  if (!confirm) {
    console.log('\nPREVIEW ONLY — nothing written. Re-run with --confirm to rotate these accounts.');
    return;
  }

  // 2. Collect every new password BEFORE writing anything, so a cancelled
  //    prompt halfway through cannot leave half the accounts rotated.
  const pending = [];
  for (const u of users) {
    let password;
    if (usePrompt) {
      password = await readHidden(`new password for ${u.email} (hidden): `);
      if (password.length < 12) {
        console.error(`refused: password for ${u.email} is shorter than 12 characters; nothing written.`);
        process.exit(1);
      }
    } else {
      password = randomBytes(12).toString('base64url');
    }
    pending.push({ user: u, password, hash: await argon2Hash(password) });
  }

  // 3. Write — ALL accounts in ONE transaction. Hashing already happened
  //    above, so the transaction only carries fast writes: either every named
  //    account is rotated with its sessions revoked, or none is.
  let results;
  try {
    results = await prisma.$transaction(
      async (tx) => {
        const out = [];
        for (const p of pending) {
          await tx.posUser.update({
            where: { id: p.user.id },
            data: { passwordHash: p.hash, mustChangePassword: !demo },
          });
          const r = await tx.posSession.updateMany({
            where: { userId: p.user.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await tx.posAuditLog.create({
            data: {
              action: 'PASSWORD_ROTATED',
              entity: 'PosUser',
              entityId: p.user.id,
              companyId: p.user.companyId,
              actorEmail: process.env.POS_ROTATE_ACTOR || 'scripts/rotate-pos-passwords.mjs',
              // `forcedChange: false` is the audit trail's record that a
              // security control was switched off on purpose, and for which
              // account. Do not drop it.
              meta: {
                sessionsRevoked: r.count,
                source: 'scoped-rotation',
                prompted: usePrompt,
                forcedChange: !demo,
                demoCredential: demo,
              },
            },
          });
          out.push({ email: p.user.email, id: p.user.id, revoked: r.count, password: usePrompt ? null : p.password });
        }
        return out;
      },
      { timeout: 30000 },
    );
  } catch (err) {
    console.error(`\nFAILED during the rotation transaction: ${err.message}`);
    console.error('The transaction was rolled back — no password and no session was changed.');
    console.error('Nothing to recover; fix the cause and re-run. (Verify with the §5 audit query.)');
    process.exit(1);
  }

  // 4. Independent read-back: a committed transaction should make all of this
  //    true at once. If it does not, say exactly which account is off rather
  //    than reporting a clean rotation.
  const after = await prisma.posUser.findMany({
    where: { id: { in: results.map((r) => r.id) } },
    select: {
      id: true,
      email: true,
      mustChangePassword: true,
      sessions: { where: { revokedAt: null }, select: { id: true } },
    },
  });
  // Assert the state we asked for, not a fixed one: --demo inverts the
  // mustChangePassword expectation, so checking for `true` unconditionally
  // would report every demo rotation as broken.
  const expectMustChange = !demo;
  const bad = after.filter((u) => u.mustChangePassword !== expectMustChange || u.sessions.length > 0);
  if (bad.length) {
    console.error(
      `\nPARTIAL/INCONSISTENT STATE — expected mustChangePassword=${expectMustChange} and 0 live sessions:`,
    );
    for (const u of bad) {
      console.error(`  ${u.email}  mustChangePassword=${u.mustChangePassword}  live-sessions=${u.sessions.length}`);
    }
    console.error('Re-running the script for the affected emails is safe and is the repair.');
    process.exit(1);
  }

  console.log(
    `\nrotated (one transaction; forced password change is ${demo ? 'OFF — DEMO CREDENTIALS' : 'ON for each account'}):`,
  );
  for (const r of results) {
    console.log(`  ${r.email}  sessions-revoked=${r.revoked}`);
  }
  if (demo) {
    console.log('\nNOTE: --demo left mustChangePassword=false. These passwords stay valid');
    console.log('until someone rotates them again. Do not use --demo for real accounts.');
  }

  if (!usePrompt) {
    if (outFile) {
      const body = [
        '# ATC POS demo credentials',
        `# generated ${new Date().toISOString()} by scripts/rotate-pos-passwords.mjs`,
        `# forced password change on first sign-in: ${demo ? 'NO (--demo)' : 'YES'}`,
        '# Treat this file as a secret. Delete it once the credentials are handed over.',
        '',
        ...results.map((r) => `${r.email}\t${r.password}`),
        '',
      ].join('\n');
      writeFileSync(outFile, body, { mode: 0o600, flag: 'wx' });
      console.log(`\nNEW PASSWORDS WRITTEN TO ${outFile} (mode 0600). Not shown here by design.`);
    } else {
      console.log('\n--- NEW PASSWORDS — shown ONCE. Record them now, then clear this screen. ---');
      for (const r of results) console.log(`  ${r.email}  ${r.password}`);
      console.log('--- end ---');
    }
  }
};

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('FAILED:', err.message);
    await prisma.$disconnect();
    process.exit(1);
  });

// Shared config for the POS dev-stack browser walkthroughs (tests/e2e).
//
// No secrets live in this repo: login passwords are read from the SAME
// POS_SEED_*_PASSWORD env vars that seeded the dev DB, so the values that
// seeded are the values that test. Values are never printed.
//
// Env:
//   POS_SEED_ADMIN_PASSWORD / POS_SEED_OWNER_PASSWORD /
//   POS_SEED_MANAGER_PASSWORD / POS_SEED_CASHIER_PASSWORD
//       required by the script that logs in with that role
//   POS_E2E_BASE        default http://127.0.0.1:5177 (dev vite)
//   POS_E2E_SHOTS       default /tmp/pos-shots (screenshot dir)
//   POS_E2E_PLAYWRIGHT  path to a playwright-core dir when it is not
//                       resolvable from this file (no node_modules at repo root)
//   POS_E2E_CHROMIUM    Chromium executable used only if the default
//                       playwright launch fails (missing bundled browser)

const BASE = process.env.POS_E2E_BASE || 'http://127.0.0.1:5177';
const SHOTS = process.env.POS_E2E_SHOTS || '/tmp/pos-shots';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    process.stdout.write(`STOP: ${name} is not set (dev seed password; value is never printed)\n`);
    process.exit(2);
  }
  return v;
}

const creds = {
  admin: () => ({ email: 'pos.admin@atcinfocom.in', password: requireEnv('POS_SEED_ADMIN_PASSWORD') }),
  owner: () => ({ email: 'demo.owner@atcpos.example', password: requireEnv('POS_SEED_OWNER_PASSWORD') }),
  manager: () => ({ email: 'demo.manager@atcpos.example', password: requireEnv('POS_SEED_MANAGER_PASSWORD') }),
  cashier: () => ({ email: 'demo.cashier@atcpos.example', password: requireEnv('POS_SEED_CASHIER_PASSWORD') }),
};

function requirePlaywright() {
  const p = process.env.POS_E2E_PLAYWRIGHT;
  try {
    return require(p || 'playwright-core');
  } catch (e) {
    process.stdout.write('STOP: playwright-core not resolvable; set POS_E2E_PLAYWRIGHT to a playwright-core dir\n');
    process.exit(2);
  }
}

async function launchBrowser(log) {
  const { chromium } = requirePlaywright();
  try {
    return await chromium.launch({ headless: true, chromiumSandbox: false });
  } catch (e) {
    if (log) log('default launch failed: ' + String(e.message || e).split('\n')[0]);
    const exe = process.env.POS_E2E_CHROMIUM;
    if (!exe) {
      process.stdout.write('STOP: default Chromium launch failed and POS_E2E_CHROMIUM is not set\n');
      process.exit(2);
    }
    return await chromium.launch({ headless: true, chromiumSandbox: false, executablePath: exe });
  }
}

module.exports = { BASE, SHOTS, creds, launchBrowser };

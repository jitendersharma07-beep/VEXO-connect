import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Directories that exist under public/ for the dev server's benefit and must
// never reach a release artifact.
//
// public/_proof/ holds the print-acceptance evidence — bill/KOT/refund PDFs,
// 203 dpi rasters and the life-size proof sheet. It lives there because the UAT
// runbook and the close-out both cite /_proof/print-preview.html on the dev
// stack: that is the URL the owner opens to compare paper against screen.
const EXCLUDED_FROM_RELEASE = ['_proof'];

// public/ is vite's publicDir and vite copies it VERBATIM into outDir, so
// git-level exclusion does nothing here — .git/info/exclude governs what git
// tracks, not what the build packages. Measured, not assumed: a build from a
// tree carrying the evidence copied all 18 files (1004 KB) into dist/, ready to
// be served at /pos/_proof/.
//
// Hence a build-layer arrangement. There are two, because they fail
// independently: this plugin covers any dist/ produced by `vite build` however
// it is later deployed, and frontend/.dockerignore keeps the bytes out of the
// image build context so Dockerfile.prod's `COPY . .` cannot carry them into
// any layer.
function excludeProofFromRelease() {
  const name = 'vexo-exclude-proof-from-release';
  let outDir = '';
  let publicDir = '';

  return {
    name,
    // Build only. The dev server serves public/ from source and never copies
    // it, so /_proof/ stays reachable for the runbook.
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      publicDir = config.publicDir ? path.resolve(config.publicDir) : '';
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        if (!publicDir || !fs.existsSync(publicDir)) return;

        // Never operate on the evidence itself. vite only warns when outDir and
        // publicDir are not separate folders; under that layout "delete the
        // copy" and "delete the original" are the same call, so refuse instead.
        const rel = path.relative(publicDir, outDir);
        const outDirInsidePublicDir = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        if (outDirInsidePublicDir) {
          throw new Error(`[${name}] outDir ${outDir} is inside publicDir ${publicDir}; refusing to remove anything.`);
        }

        // Sentinel, and the load-bearing half of this plugin. vite 6 copies
        // publicDir in prepareOutDir, i.e. before the bundle is written and
        // well before closeBundle. If a future vite moved that copy after
        // closeBundle, the removal below would run first, find nothing, report
        // success — and the copy would then re-introduce the evidence into a
        // release with no error anywhere. So require proof the copy has already
        // happened: some non-excluded public entry must already be in outDir.
        // Read from publicDir rather than hardcoding favicon.svg, so renaming
        // the real assets cannot quietly disarm the check.
        const copied = fs.readdirSync(publicDir).filter((entry) => !EXCLUDED_FROM_RELEASE.includes(entry));
        if (copied.length && !copied.some((entry) => fs.existsSync(path.join(outDir, entry)))) {
          throw new Error(
            `[${name}] none of publicDir's ${copied.length} public entrie(s) are in ${outDir}, so the publicDir copy has not run yet. ` +
              'Removing now would be a no-op and the copy would follow. Refusing to produce an artifact this plugin cannot vouch for.',
          );
        }

        for (const entry of EXCLUDED_FROM_RELEASE) {
          fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
        }

        // rmSync with force swallows a missing path but not every failure — a
        // root-owned directory fails EACCES. Assert the outcome.
        const remaining = EXCLUDED_FROM_RELEASE.filter((entry) => fs.existsSync(path.join(outDir, entry)));
        if (remaining.length) {
          throw new Error(`[${name}] still present in ${outDir} after removal: ${remaining.join(', ')}`);
        }
      },
    },
  };
}

// VITE_BASE_PATH is "/" in dev and "/pos/" in the production image so the SPA
// works when served under https://atcworkspace.com/pos/.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), excludeProofFromRelease()],
  server: {
    port: 5177,
    host: true,
    proxy: {
      // api.js builds every URL as `${BASE_URL}api`, so a dev server started
      // with VITE_BASE_PATH=/pos/ — which is how you reproduce production —
      // asks for /pos/api/…. Without this rule the SPA fallback answers it
      // with index.html and a 200, so the API looks broken rather than
      // unproxied. Listed first because it is the more specific prefix.
      '/pos/api': {
        target: process.env.VITE_DEV_API || 'http://localhost:5010',
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/pos/, ''),
      },
      '/api': {
        target: process.env.VITE_DEV_API || 'http://localhost:5010',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});

// NEGATIVE CONTROL for the release-artifact exclusion check. Not part of the
// product build and never referenced by Dockerfile.prod or package.json.
//
// It loads the real vite.config.js and removes ONLY the exclusion plugin, then
// builds into dist-negctl/. If the check harness reports "0 of 18 evidence
// files in dist" while this control also reports 0, the harness is measuring
// nothing and the green is false. The control must come back 18 of 18.
//
// Written by hand rather than by editing the real config, so the instrument
// under test is never modified to make a check pass.
//
// Run from frontend/, which is where Dockerfile.prod's build runs:
//   npx vite build --config qa/vite.config.negctl.mjs
// --config does not move vite's root, so outDir still resolves under frontend/.
//
// dist-negctl has to be covered by .dockerignore, and now is via `dist*`: this
// directory is by construction full of the very evidence the release must not
// carry, and on this check's first run it put 19 entries into the build context
// while public/_proof/ itself was correctly excluded.
import base from '../vite.config.js';

const STRIP = 'vexo-exclude-proof-from-release';

// react() returns an array of plugins, so a plugins entry can itself be an
// array; flatten one level before matching on name.
const kept = (base.plugins || []).filter((entry) => {
  const flat = Array.isArray(entry) ? entry : [entry];
  return !flat.some((p) => p && p.name === STRIP);
});

if (kept.length === (base.plugins || []).length) {
  throw new Error(`negative control: plugin ${STRIP} was not found in vite.config.js, so nothing was disarmed`);
}

export default {
  ...base,
  plugins: kept,
  build: { ...(base.build || {}), outDir: 'dist-negctl' },
};

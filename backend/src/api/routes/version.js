import { Router } from 'express';
import { requirePosAuth } from '../../middleware/auth.js';
import { requireAtc } from '../../middleware/rbac.js';
import { buildInfo } from '../../lib/buildInfo.js';

const router = Router();

// Gated, and gated at POS_SUPER_ADMIN rather than at "any signed-in user": a
// commit SHA tells an attacker which published fixes this deploy does NOT have,
// and a café cashier has no more business knowing it than the public does.
//
// The cost is real and worth stating: requirePosAuth reads PosSession and
// PosUser, so this route now needs the database. It is therefore NOT the
// channel to use during a bad deploy, which is exactly when the database is
// what is down. Those channels are the image label
// (`docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`)
// and the container env (`docker exec pos-prod-backend-1 printenv GIT_SHA`),
// both of which answer with nothing running but dockerd.
//
// Still a separate route from /api/health because the two answer to different
// callers: /api/health is public and unauthenticated by necessity — the compose
// healthcheck and deploy/prod-verify.mjs both read it — so provenance cannot
// live there without being public too.
router.use(requirePosAuth, requireAtc);

router.get('/', (_req, res) => {
  res.json(buildInfo);
});

export default router;

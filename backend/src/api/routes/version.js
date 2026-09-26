import { Router } from 'express';
import { buildInfo } from '../../lib/buildInfo.js';

const router = Router();

// Deliberately does NOT touch the database, and is deliberately not the same
// route as /api/health.
//
// The question this answers — "which commit is running?" — is asked most often
// during a bad deploy, and a bad deploy is exactly when the database is the
// thing that is down. Hanging provenance off the health check would make the
// answer unavailable in the one situation that needs it, and would also give the
// container healthcheck a second reason to fail.
router.get('/', (_req, res) => {
  res.json(buildInfo);
});

export default router;

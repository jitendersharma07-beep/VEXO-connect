import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { env, gatewayEnabled } from './config/env.js';
import { logger, resSerializer } from './lib/logger.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

import healthRoutes from './api/routes/health.js';
import authRoutes from './api/routes/auth.js';
import dashboardRoutes from './api/routes/dashboard.js';
import branchRoutes from './api/routes/branches.js';
import userRoutes from './api/routes/users.js';
import licenseRoutes from './api/routes/license.js';
import atcRoutes from './api/routes/atc.js';
import catalogRoutes from './api/routes/catalog.js';
import tableRoutes from './api/routes/tables.js';
import orderRoutes from './api/routes/orders.js';
import discountPolicyRoutes from './api/routes/discountPolicies.js';
import reportRoutes from './api/routes/reports.js';
import menuProfitabilityRoutes from './api/routes/menuProfitability.js';
import displayRoutes from './api/routes/display.js';
import kitchenRoutes from './api/routes/kitchen.js';
import { printAgentsRouter, printJobsRouter } from './api/routes/printing.js';
import gatewayRoutes from './api/routes/gateway.js';

// LANE foundation — the organisation, device and permission surface.
import legalEntityRoutes from './api/routes/legalEntities.js';
import gstRegistrationRoutes from './api/routes/gstRegistrations.js';
import brandRoutes from './api/routes/brands.js';
import regionRoutes from './api/routes/regions.js';
import terminalRoutes from './api/routes/terminals.js';
import deviceRoutes from './api/routes/devices.js';
import permissionRoutes from './api/routes/permissions.js';
// LANE vc104-api
import phoneOrderRoutes from './api/routes/phoneOrders.js';
import reportingRoutes from './api/routes/reporting.js';

// LANE foundation, Phase 2 — VC-102.
import promotionRoutes from './api/routes/promotions.js';

// LANE accounts — onboarding, invitations and account recovery.
import accountRecoveryRoutes from './api/routes/accountRecovery.js';
import invitationRoutes, { publicRouter as inviteAcceptRoutes } from './api/routes/invitations.js';

export const createApp = () => {
  const app = express();

  // TWO proxies sit in front of this app in production, not one: the host
  // nginx that owns atcworkspace.com, and the nginx inside the frontend
  // container that serves the bundle and forwards /api. Each appends to
  // X-Forwarded-For, so the client's real address is the second entry from
  // the right and `1` lands on the docker bridge gateway instead.
  //
  // That is not a cosmetic difference. `req.ip` is the key for both rate
  // limiters, so with the wrong count every device in the café shares one
  // counter: ten mistyped passwords from a single cashier lock the entire
  // shop out of sign-in for fifteen minutes, owner included, mid-service.
  // Measured before the change — a request over the public URL and one over
  // loopback, two completely different client addresses, drew down the same
  // global counter (299 → 295 → 294).
  //
  // Counting from the right is also what makes it unspoofable. A client that
  // sends its own X-Forwarded-For only pushes values further left, past the
  // two entries the proxies guarantee.
  app.set('trust proxy', 2);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }),
  );

  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      serializers: { res: resSerializer },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(globalLimiter);

  // Ahead of express.json, because signature verification needs the exact
  // bytes the provider signed. Mounted only when a provider is configured, so
  // a deployment without a gateway has no webhook endpoint to probe at all.
  if (gatewayEnabled) {
    app.use('/api/gateway', gatewayRoutes);
  }

  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.json({
      name: env.APP_NAME,
      vendor: 'ATC Infocom Solutions Pvt. Ltd.',
      status: 'ok',
      docs: '/api/health',
    });
  });

  const api = express.Router();
  api.get('/config', (_req, res) => {
    res.json({ appName: env.APP_NAME, product: 'atc-pos', vendor: 'ATC Infocom Solutions Pvt. Ltd.' });
  });
  api.use('/health', healthRoutes);
  api.use('/auth', authRoutes);
  // Second router on /auth: recovery is public and unauthenticated, and
  // keeping it in its own file stops the signed-in surface and the
  // not-signed-in-and-cannot-prove-anything surface sharing middleware by
  // accident. Express falls through, so no path here collides with the above.
  api.use('/auth', accountRecoveryRoutes);
  // Accepting an invitation is unauthenticated by definition — the account
  // does not exist yet — so it lives on its own path rather than under the
  // managed surface, and no signed-in middleware can leak onto it by being
  // added to the wrong router.
  api.use('/invite', inviteAcceptRoutes);
  api.use('/invitations', invitationRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/branches', branchRoutes);
  api.use('/users', userRoutes);
  api.use('/license', licenseRoutes);
  api.use('/atc', atcRoutes);
  api.use('/catalog', catalogRoutes);
  api.use('/tables', tableRoutes);
  api.use('/orders', orderRoutes);
  api.use('/discount-policies', discountPolicyRoutes);
  // VC-105. Mounted before /reports so the more specific path wins.
  api.use('/reports/menu-profitability', menuProfitabilityRoutes);
  api.use('/reports', reportRoutes);
  api.use('/display', displayRoutes);
  api.use('/kitchen', kitchenRoutes);
  api.use('/print-agents', printAgentsRouter);
  api.use('/print-jobs', printJobsRouter);

  // LANE foundation — mounted after /branches so the store routes keep their
  // place in the table; order is irrelevant to Express here, none of these
  // paths is a prefix of another.
  api.use('/legal-entities', legalEntityRoutes);
  api.use('/gst-registrations', gstRegistrationRoutes);
  api.use('/brands', brandRoutes);
  api.use('/regions', regionRoutes);
  api.use('/terminals', terminalRoutes);
  api.use('/devices', deviceRoutes);
  api.use('/permissions', permissionRoutes);
  api.use('/promotions', promotionRoutes);

  // LANE vc104-api
  api.use('/phone-orders', phoneOrderRoutes);

  // LANE reporting. A sibling of /reports, not a replacement: that router is the
  // contract §10 sales report the POS still calls, and neither path is a prefix
  // of the other.
  api.use('/reporting', reportingRoutes);

  app.use('/api', api);
  app.use('/health', healthRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export default createApp;

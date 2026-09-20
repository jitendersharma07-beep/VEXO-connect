import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';

import healthRoutes from './api/routes/health.js';
import authRoutes from './api/routes/auth.js';
import dashboardRoutes from './api/routes/dashboard.js';
import branchRoutes from './api/routes/branches.js';
import userRoutes from './api/routes/users.js';
import licenseRoutes from './api/routes/license.js';
import atcRoutes from './api/routes/atc.js';

export const createApp = () => {
  const app = express();

  app.set('trust proxy', 1);

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

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/api/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(globalLimiter);

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
  api.use('/dashboard', dashboardRoutes);
  api.use('/branches', branchRoutes);
  api.use('/users', userRoutes);
  api.use('/license', licenseRoutes);
  api.use('/atc', atcRoutes);

  app.use('/api', api);
  app.use('/health', healthRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export default createApp;

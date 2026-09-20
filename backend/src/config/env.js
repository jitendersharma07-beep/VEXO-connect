const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 5010),
  APP_NAME: process.env.APP_NAME || 'ATC POS',
  APP_URL: process.env.APP_URL || 'http://localhost:5177',
  DATABASE_URL: required('DATABASE_URL'),
  // POS signs with its own secret; an ATC NOC / Megatel / AGR token can never
  // verify here and a POS token can never verify there.
  POS_JWT_SECRET: required('POS_JWT_SECRET'),
  SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || 'pos_session',
  SESSION_TTL_HOURS: Number(process.env.SESSION_TTL_HOURS || 12),
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5177',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

if (env.POS_JWT_SECRET.length < 32) {
  throw new Error('POS_JWT_SECRET must be at least 32 characters');
}

import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  nodeEnv: env.NODE_ENV || 'development',

  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    socketPath: env.DB_SOCKET || '',
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'channel_manager',
    connectionLimit: Number(env.DB_POOL || 10),
  },

  auth: {
    jwtSecret: env.JWT_SECRET || 'dev-only-change-me',
    tokenTtl: env.JWT_TTL || '12h',
  },

  worker: {
    // How many jobs one worker pass claims. Kept small so several workers
    // share the queue evenly rather than one grabbing everything.
    batchSize: Number(env.WORKER_BATCH || 20),
    pollMs: Number(env.WORKER_POLL_MS || 1000),
    // Retry backoff in seconds, indexed by attempt number.
    backoff: [5, 30, 120, 600, 1800],
  },

  // How far ahead the calendar and the sync operate.
  calendar: {
    maxDays: Number(env.CALENDAR_MAX_DAYS || 90),
    defaultDays: Number(env.CALENDAR_DEFAULT_DAYS || 30),
  },
};

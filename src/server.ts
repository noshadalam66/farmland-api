import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import pg from 'pg';
import { createApp } from './app.js';
import { FarmStore } from './farm.js';
import { LeaderboardStore } from './leaderboard.js';

const { DATABASE_URL, FIREBASE_PROJECT_ID, WEB_ORIGIN, PORT } = process.env;
if (Boolean(DATABASE_URL) !== Boolean(FIREBASE_PROJECT_ID)) {
  throw new Error('Set DATABASE_URL and FIREBASE_PROJECT_ID together to enable the farm API.');
}

const pool = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL }) : undefined;
const services = pool && FIREBASE_PROJECT_ID ? {
  store: new FarmStore(pool),
  leaderboard: new LeaderboardStore(pool),
  verifyToken: (token: string) => getAuth().verifyIdToken(token),
} : undefined;
if (services) initializeApp({ projectId: FIREBASE_PROJECT_ID });

const app = createApp(services, WEB_ORIGIN);
app.addHook('onClose', async () => { await pool?.end(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}

try {
  await app.listen({ host: '0.0.0.0', port: Number(PORT ?? 8080) });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

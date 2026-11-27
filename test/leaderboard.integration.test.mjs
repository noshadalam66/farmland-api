import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';
import { LeaderboardStore } from '../dist/leaderboard.js';

test('harvest ranking uses committed actions and reveals only opted-in aliases', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migration 000012.');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const players = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [leader, tied, privateFarm, lower] = players;
  const app = createApp({
    store: new FarmStore(pool),
    leaderboard: new LeaderboardStore(pool),
    verifyToken: async (uid) => {
      if (!players.includes(uid)) throw new Error('Unknown account');
      return { uid };
    },
  }, 'https://farm.example');
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM farm_leaderboard_preferences WHERE player_uid = ANY($1)', [players]);
      await pool.query('DELETE FROM starter_farms WHERE player_uid = ANY($1)', [players]);
    } finally {
      await pool.end();
    }
  });

  const read = (uid) => app.inject({ url: '/v1/leaderboard/harvests', headers: { authorization: `Bearer ${uid}` } });
  const preference = (uid, enabled, extra = {}) => app.inject({
    method: 'PUT',
    url: '/v1/leaderboard/preferences',
    headers: { authorization: `Bearer ${uid}` },
    payload: { enabled, ...extra },
  });

  await pool.query('INSERT INTO starter_farms (player_uid) SELECT unnest($1::text[])', [players]);
  for (const [uid, count] of [[leader, 3], [tied, 3], [privateFarm, 20], [lower, 1]]) {
    await pool.query(
      `INSERT INTO starter_farm_commands (player_uid, command_id, action, expected_revision, response)
       SELECT $1, gen_random_uuid(), 'harvest', n, '{}' FROM generate_series(1, $2::int) n`,
      [uid, count],
    );
  }

  const preflight = await app.inject({
    method: 'OPTIONS', url: '/v1/leaderboard/preferences',
    headers: {
      origin: 'https://farm.example',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-methods'], /\bPUT\b/);
  assert.equal((await read('invalid')).statusCode, 401);
  assert.equal((await read(privateFarm)).json().enabled, false);
  assert.equal((await preference(leader, true, { score: 999 })).statusCode, 400);
  assert.equal((await preference(leader, 'true')).statusCode, 400);
  for (const uid of [leader, tied, lower]) assert.equal((await preference(uid, true)).statusCode, 204);

  const ranked = await read(leader);
  assert.equal(ranked.statusCode, 200);
  const data = ranked.json();
  assert.equal(data.category, 'harvests');
  assert.equal(data.enabled, true);
  assert.deepEqual(data.entries.map(({ rank, harvests }) => [rank, harvests]), [[1, 3], [1, 3], [3, 1]]);
  assert.equal(data.entries.filter((entry) => entry.isYou).length, 1);
  assert.deepEqual(data.yourRank, data.entries.find((entry) => entry.isYou));
  assert.match(data.yourRank.name, /^Farm [a-f0-9]{12}$/);
  for (const uid of players) assert.ok(!ranked.body.includes(uid));
  assert.equal((await read(privateFarm)).json().yourRank, null);

  assert.equal((await preference(leader, false)).statusCode, 204);
  assert.equal((await read(leader)).json().yourRank, null);
  assert.equal((await read(tied)).json().entries.length, 2);
  await preference(leader, true);
  assert.equal((await read(leader)).json().yourRank.name, data.yourRank.name);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';

test('town buildings charge once and residents arrive from server time', async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a test database with migration 000013.');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const uid = randomUUID();
  const other = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    verifyToken: async (token) => ({ uid: token === 'other' ? other : uid }),
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM starter_farms WHERE player_uid = ANY($1)', [[uid, other]]);
    } finally {
      await pool.end();
    }
  });

  const send = (command, token = 'first') => app.inject({
    method: 'POST', url: '/v1/farm/commands',
    headers: { authorization: `Bearer ${token}` }, payload: command,
  });
  const load = (token) => app.inject({ url: '/v1/farm', headers: { authorization: `Bearer ${token}` } });
  const command = (expectedRevision, action, building) => ({
    commandId: randomUUID(), expectedRevision, action, ...(building ? { building } : {}),
  });

  assert.equal((await send(command(0, 'build_town', 'road'))).json().code, 'town_requires_expansion');
  await pool.query('UPDATE starter_farms SET coins = 60 WHERE player_uid = $1', [uid]);
  const expansion = (await send(command(0, 'buy_parcel'))).json();
  assert.equal(expansion.expansion.owned, true);
  assert.equal((await send(command(expansion.revision, 'build_town', 'cottage'))).json().code, 'town_requires_road');
  assert.equal((await send(command(expansion.revision, 'build_town', 'clinic'))).statusCode, 400);
  assert.equal((await send({ ...command(expansion.revision, 'build_town', 'road'), price: 0 })).statusCode, 400);

  const road = await send(command(expansion.revision, 'build_town', 'road'));
  assert.equal(road.statusCode, 200);
  const connected = road.json();
  assert.equal(connected.town.buildings[0].kind, 'road');
  assert.equal((await send(command(connected.revision, 'build_town', 'road'))).json().code, 'town_building_limit');

  const buy = command(connected.revision, 'build_town', 'cottage');
  const attempts = await Promise.all([send(buy), send(buy, 'second')]);
  assert.ok(attempts.every((response) => response.statusCode === 200));
  const built = attempts[0].json();
  assert.deepEqual(attempts[1].json(), built);
  assert.equal(built.wallet.coins, connected.wallet.coins - connected.town.catalog.cottage.price);
  assert.equal(built.town.housingCapacity, 3);
  assert.equal(built.town.residents, 0);
  assert.equal(built.town.buildings.length, 2);
  assert.equal((await send({ ...buy, building: 'road' })).json().code, 'command_id_reused');

  await pool.query("UPDATE farm_town_buildings SET built_at = now() - interval '125 seconds' WHERE player_uid = $1 AND kind = 'cottage'", [uid]);
  assert.equal((await load('second')).json().town.residents, 2);
  assert.equal((await load('other')).json().town.buildings.length, 0);
  await pool.query("UPDATE farm_town_buildings SET built_at = now() - interval '24 hours' WHERE player_uid = $1 AND kind = 'cottage'", [uid]);
  assert.equal((await load('first')).json().town.residents, 3);
  const ledger = await pool.query(
    "SELECT coin_delta FROM farm_wallet_entries WHERE player_uid = $1 AND reason = 'town_construction' ORDER BY coin_delta",
    [uid],
  );
  assert.deepEqual(ledger.rows, [{ coin_delta: -12 }, { coin_delta: -6 }]);
});

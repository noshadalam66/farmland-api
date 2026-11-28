import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { FarmStore } from '../dist/farm.js';

test('the farming loop works across sessions with real crop timers', {
  skip: process.env.TEST_REAL_CROP_TIMERS !== '1',
  timeout: 300_000,
}, async (t) => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a migrated disposable database.');
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const uid = randomUUID();
  const app = createApp({
    store: new FarmStore(pool),
    verifyToken: async () => ({ uid }),
  });
  t.after(async () => {
    try {
      await app.close();
      await pool.query('DELETE FROM starter_farms WHERE player_uid = $1', [uid]);
    } finally {
      await pool.end();
    }
  });

  async function request(session, command, status = 200) {
    const response = await app.inject({
      method: command ? 'POST' : 'GET',
      url: command ? '/v1/farm/commands' : '/v1/farm',
      headers: { authorization: `Bearer ${session}` },
      payload: command,
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  }

  const command = (state, action, fields = {}) =>
    ({ commandId: randomUUID(), expectedRevision: state.revision, action, ...fields });
  const submit = (session, state, action, fields) => request(session, command(state, action, fields));
  const waitFor = (state, ...plots) =>
    wait(Math.max(0, ...plots.map((plot) => Date.parse(plot.readyAt) - Date.parse(state.serverTime))) + 250);

  const fresh = await request('first-session');
  const rice = await submit('first-session', fresh, 'plant', { crop: 'rice' });
  assert.equal(rice.plot.crop, 'rice');
  const early = command(rice, 'harvest');
  assert.equal((await request('first-session', early, 409)).code, 'crop_not_ready');
  t.diagnostic('Waiting for rice to mature with no farm requests.');
  await waitFor(rice, rice.plot);

  const returned = await request('return-session');
  assert.deepEqual(returned.plot, rice.plot);
  assert.ok(Date.parse(returned.serverTime) >= Date.parse(returned.plot.readyAt));
  const harvested = await submit('return-session', returned, 'harvest');
  assert.equal(harvested.inventory.rice, 1);
  const sale = command(harvested, 'sell', { crop: 'rice' });
  const sold = await request('return-session', sale);
  assert.equal(sold.inventory.rice, 0);
  assert.equal(sold.wallet.coins, harvested.wallet.coins + harvested.market.sellPrices.rice);
  assert.deepEqual(await request('third-session', sale), sold);

  const purchase = command(sold, 'buy_parcel');
  const expanded = await request('third-session', purchase);
  assert.equal(expanded.expansion.owned, true);
  assert.equal(expanded.wallet.coins, sold.wallet.coins - sold.expansion.price);
  assert.deepEqual(await request('return-session', purchase), expanded);

  const wheat = await submit('third-session', expanded, 'plant', { crop: 'wheat' });
  const both = await submit('third-session', wheat, 'plant', { crop: 'corn', plotId: 'expansion' });
  assert.equal(both.plot.crop, 'wheat');
  assert.equal(both.expansion.plot.crop, 'corn');
  t.diagnostic('Waiting for wheat and corn to mature independently.');
  await waitFor(both, both.plot, both.expansion.plot);

  const resumed = await request('return-session');
  assert.deepEqual(resumed.plot, both.plot);
  assert.deepEqual(resumed.expansion.plot, both.expansion.plot);
  const harvestedWheat = await submit('return-session', resumed, 'harvest');
  assert.deepEqual(harvestedWheat.expansion.plot, both.expansion.plot);
  const finish = await submit('third-session', harvestedWheat, 'harvest', { plotId: 'expansion' });
  assert.equal(finish.plot, null);
  assert.equal(finish.expansion.plot, null);
  assert.equal(finish.inventory.wheat, 1);
  assert.equal(finish.inventory.corn, 1);
  const saved = await request('first-session');
  assert.equal(saved.revision, finish.revision);
  assert.deepEqual(saved.inventory, finish.inventory);
  assert.deepEqual(saved.wallet, finish.wallet);
});

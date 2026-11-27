import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const { FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_PROJECT_ID, FARM_API_ORIGIN, WEB_ORIGIN } = process.env;
assert.match(FIREBASE_PROJECT_ID ?? '', /^demo-/);
assert.match(FIREBASE_AUTH_EMULATOR_HOST ?? '', /^(127\.0\.0\.1|localhost):[0-9]+$/);
assert.match(FARM_API_ORIGIN ?? '', /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/);

const firebaseOrigin = `http://${FIREBASE_AUTH_EMULATOR_HOST}`;
const email = `phase-one-${randomUUID()}@example.test`;
const password = randomUUID();
const credentials = { email, password, returnSecureToken: true };

async function request(url, options, expectedStatus) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expectedStatus, `${options.method} ${new URL(url).pathname}`);
  return response;
}

async function firebase(method) {
  const response = await request(
    `${firebaseOrigin}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=demo-key`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) },
    200,
  );
  return response.json();
}

async function farm(token, command, expectedStatus = 200, origin) {
  const response = await request(
    FARM_API_ORIGIN + (command ? '/v1/farm/commands' : '/v1/farm'),
    {
      method: command ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(command ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: command ? JSON.stringify(command) : undefined,
    },
    expectedStatus,
  );
  if (origin) assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  return response.json();
}

await firebase('signUp');
const android = await firebase('signInWithPassword');
const web = await firebase('signInWithPassword');
const ios = await firebase('signInWithPassword');
assert.equal(android.localId, web.localId);
assert.equal(android.localId, ios.localId);
await farm('invalid-token', undefined, 401);

const start = await farm(android.idToken);
assert.equal(start.revision, 0);
assert.equal(start.plot, null);

const plant = { action: 'plant', commandId: randomUUID(), expectedRevision: start.revision };
const planted = await farm(android.idToken, plant);
const browser = await farm(web.idToken, undefined, 200, WEB_ORIGIN);
assert.deepEqual(browser.plot, planted.plot);
assert.equal(browser.revision, planted.revision);
assert.equal(Date.parse(browser.plot.readyAt) - Date.parse(browser.plot.plantedAt), 60_000);

const refresh = await request(
  `${firebaseOrigin}/securetoken.googleapis.com/v1/token?key=demo-key`,
  {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ios.refreshToken }),
  },
  200,
);
const { id_token: refreshedToken, user_id: refreshedUid } = await refresh.json();
assert.equal(refreshedUid, ios.localId);
assert.ok(refreshedToken);

const harvest = { action: 'harvest', commandId: randomUUID(), expectedRevision: browser.revision };
assert.equal((await farm(refreshedToken, harvest, 409)).code, 'crop_not_ready');
console.log('One account loaded the same plot across three sign-ins. Waiting for the real crop timer.');
await wait(Math.max(0, Date.parse(browser.plot.readyAt) - Date.parse(browser.serverTime)) + 250);

const harvested = await farm(refreshedToken, harvest);
assert.equal(harvested.plot, null);
assert.equal(harvested.inventory.wheat, 1);
assert.deepEqual(await farm(web.idToken, harvest), harvested);

const reopened = await firebase('signInWithPassword');
const saved = await farm(reopened.idToken);
assert.equal(saved.plot, null);
assert.equal(saved.revision, start.revision + 2);
assert.equal(saved.inventory.wheat, 1);
console.log('Phase 1 service acceptance passed: Firebase sign-in and refresh, shared save, real timer, and one harvest.');

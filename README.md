# FarmLand Empire API

Fastify and TypeScript service for the shared game backend. The initial endpoint is `GET /healthz`.

Run locally with Node.js 24.

```sh
npm ci
npm run dev
curl http://localhost:8080/healthz
```

Build with `npm run build` and start the compiled service with `npm start`. Set `PORT` to override the default.

The first gameplay milestone adds Firebase identity verification, server-authoritative farm commands and server-time crop progression. Database migrations live in `farmland-db`.

Open pull requests against `main` after the initial bootstrap.

## Starter farm

Apply migrations in `farmland-db` including `000002_starter_farms.sql` and
`000005_crop_variety.sql` `000006_crop_market.sql`, and `000007_farm_expansion.sql`, set
`DATABASE_URL` and `FIREBASE_PROJECT_ID`, and restart the server. For the Unity
Web shell, set `WEB_ORIGIN` to the exact origin that serves it. With both required
variables unset the service exposes only the health endpoint.

All farm requests use `Authorization: Bearer <Firebase ID token>`. Use the same
Firebase project and player account across platforms.

| Request | Result |
| --- | --- |
| `GET /v1/farm` | Latest confirmed plot, wheat inventory, revision, and server time. A new farm starts empty at revision zero. |
| `POST /v1/farm/commands` | Applies one action and returns the updated farm. |

A command body looks like this:

```json
{
  "commandId": "e2a23624-705b-4a1b-97eb-94e3670777d8",
  "expectedRevision": 0,
  "action": "plant"
}
```

Use the revision from the latest state and a fresh UUID for each new action.
For `plant`, add a `crop` of `wheat`, `corn`, or `rice`. Omitting it plants
wheat. The prototype uses 60, 90, and 120 second timers respectively.
`harvest` takes no crop parameter. It clears the ready plot and adds one of
the crop that was planted. State includes `plot` (null or
`{ crop, plantedAt, readyAt }`), inventory totals for each crop, `revision`,
and `serverTime`. All times are UTC ISO 8601.

Send `action: "sell"` with a crop to sell one harvested unit. The server
deducts inventory and credits `wallet.coins` at the current
`market.sellPrices[crop]`. The prototype prices are 3 for wheat, 5 for corn,
and 7 for rice. Empty stock returns HTTP 409 with `insufficient_crop`.
The wallet entry and command receipt commit together.

Send `action: "buy_parcel"` to buy the single pilot expansion for the
server-provided `expansion.price` (7 coins). Once `expansion.owned` is true,
plant and harvest may specify `plotId: "expansion"`. Omitting `plotId` uses the
starter plot. The expansion has its own timer in `expansion.plot`.

After a lost response, retry the same command unchanged. The API returns the
original committed snapshot, which may be older than the latest farm state.
Refresh via GET before presenting the state after a retry. Conflicts return
HTTP 409 with `{ code, state }`, including the latest state as of the check.
Rejected actions leave progress unchanged.

Run `TEST_DATABASE_URL=postgresql://… npm run test:integration` against a test
database with migrations 000002 and 000005–000007 applied. The test runs actual PostgreSQL
transactions and substitutes an in-process token verifier.

### Phase 1 service acceptance

Run Firebase Authentication Emulator for a `demo-*` project and start this API
with the matching `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_EMULATOR_HOST`
(for example, `127.0.0.1:9099`), and a disposable PostgreSQL database with the
farm migrations applied. The Admin SDK uses emulator mode when this variable
is set. Keep it out of deployments.

In a second terminal, use the same Firebase values and set
`FARM_API_ORIGIN=http://127.0.0.1:8080`. Optionally set the same `WEB_ORIGIN`
as the API to assert its browser response header. Run:

```sh
node test/phase-one-acceptance.mjs
```

The script creates a unique emulator user, signs in three times, refreshes an
ID token, and waits for the actual crop timer. It verifies that observers see
the same plot and a replayed harvest awards wheat once. Run against disposable
services because the test leaves its account and farm in the test databases.
The Unity Play Mode and device handoff checks are separate.

## World selection

Apply world migrations `000003` and `000004` from `farmland-db`. Authenticate
with the same Firebase account as the farm endpoints.

- `POST /v1/world` accepts `{ requestId, latitude, longitude, areaKm2 }`.
  Provide a UUID, center coordinates in WGS 84, and an area preset of 1, 4,
  or 9 square kilometers. The initial supported center range is ±80° latitude
  and longitude from −180° inclusive to 180° exclusive.
- The first request returns HTTP 201 with the world ID and queued status.
  Repeating the same request returns the saved world. Reusing an ID with
  different inputs or submitting another world for the account returns HTTP 409.
- `GET /v1/world` returns the caller's world or HTTP 404 if they have no world.

One selection per account is supported in the pilot. Run one terrain job with `npm run terrain:once` after `npm run build`.
Set `DATABASE_URL`, `TERRAIN_ROOT`, `TERRAIN_SOURCE` (the raster file path),
and `TERRAIN_SOURCE_ID` (a versioned dataset reference). Set `TERRAIN_PYTHON`
if the GDAL bindings are installed in a different Python interpreter.
A worker can reclaim an interrupted job after its five-minute lease.

Set the same `TERRAIN_ROOT` on the API with read access to the worker's output.
For a ready world, the authenticated owner can GET
`/v1/world/terrain/manifest.json` and the named chunks under
`/v1/world/terrain/`. This pilot uses shared local storage and one operator-
selected source raster.

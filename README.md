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

Apply farm migrations 000002 and 000005–000011 from `farmland-db`. Set
`DATABASE_URL` and `FIREBASE_PROJECT_ID`, then restart the server. For the Unity
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

Send `action: "buy_animal"` with `species: "goat"` or `"chicken"` to
purchase one animal at the server price. The farm response exposes
`livestock.animals`, `livestock.prices`, and `livestock.capacity`. The
prototype prices are 12 and 6 coins, with a shared capacity of eight animals.
Animal creation, coin debit, and receipt are committed together.

Submit `feed_animal` with an owned `animalId` to spend one wheat. Chickens
produce eggs in 60 seconds and goats produce milk in 90 seconds. The roster
exposes each animal's `productReadyAt`. Once ready, submit `collect_animal`
with its ID to add one unit to `inventory.eggs` or `inventory.milk`. Feeding
cannot reset a timer or consume another unit while a product is pending.

Submit `start_breeding` with `animalId` and `partnerId`. The pilot requires
two adult, opposite-sex animals of the same species with no shared ancestry.
One pending pair per account reserves one livestock slot. After the
server's three-minute timer, `collect_offspring` adds the child with its
parent IDs. Children can join breeding after a two-minute maturation
period. The farm snapshot includes the pending timer and all owned animals'
parent IDs.

After a lost response, retry the same command unchanged. The API returns the
original committed snapshot, which may be older than the latest farm state.
Refresh via GET before presenting the state after a retry. Conflicts return
HTTP 409 with `{ code, state }`, including the latest state as of the check.
Rejected actions leave progress unchanged.

The grain mill supports `buy_mill`, `start_milling`, `collect_flour`, and
`sell_flour`. It processes two wheat per 60-second batch. The `mill` snapshot
supplies prices and the batch timer.

Run `TEST_DATABASE_URL=postgresql://… npm run test:integration` against a test
database with migrations 000002 and 000005–000011 applied. The test runs actual PostgreSQL
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

## Harvest leaderboard

Apply migration 000012 to enable the first global leaderboard category.
`GET /v1/leaderboard/harvests` returns the top 20 opted-in farms and the
caller's own rank when ranked. Each score counts successful harvest command
receipts. Equal scores share a rank. Names are generated aliases and the API
does not return Firebase IDs or email addresses.

Players are hidden by default. Send `PUT /v1/leaderboard/preferences` with
`{ "enabled": true }` to join or `false` to hide the entry. This pilot ranks
lifetime harvests. Seasonal snapshots and the other categories will need
their own scoring rules and reporting.
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

## Starter settlement

Apply migration 000013 and purchase the farm expansion before construction.
Send `action: "build_town"` with `building: "road"` or `"cottage"`. The town
catalog in `GET /v1/farm` supplies prices and limits. A road costs 6 coins
and unlocks cottages, which cost 12 coins. The pilot supports one road and
up to four cottages.

Each cottage has space for three residents. One arrives per minute based on
the server's construction timestamp, including while the player is away.
The snapshot reports building IDs, housing capacity, and current population.
Construction uses the same farm revision, wallet ledger, and retry receipt
as other purchases.


Migration 000014 adds a water tower, workshops, schools, and clinics.
Construction uses the same `build_town` command and the catalog's
prerequisites, limits, and prices. The town snapshot shows service capacity,
residents served, and a 0–100 wellbeing score. The score is zero until
residents arrive, then starts at 40 and adds up to 15 points each for water,
employment, school, and clinic coverage. Existing cottage arrival rules
still apply.


Migration 000015 adds daily settlement supply orders. `townOrders` reports
the UTC date, offers, prerequisites, and which offers have been filled. Send
`fulfil_town_order` with the offer's `orderKey` and displayed `orderDate`.
Wheat, flour, and milk offers unlock at two, three, and four residents.
Each offer can be fulfilled once per UTC day. Changes to inventory, coins,
and the receipt commit together.

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

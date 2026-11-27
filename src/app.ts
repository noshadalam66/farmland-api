import cors from '@fastify/cors';
import Fastify from 'fastify';
import { millActions } from './mill.js';
import { animalSpecies } from './livestock.js';
import { crops, type FarmCommand, type FarmStore } from './farm.js';

type FarmServices = {
  store: Pick<FarmStore, 'load' | 'execute'>;
  verifyToken: (token: string) => Promise<{ uid: string }>;
};

const commandSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commandId', 'expectedRevision', 'action'],
  properties: {
    commandId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    expectedRevision: { type: 'integer', minimum: 0, maximum: 2147483647 },
    action: { type: 'string', enum: ['plant', 'harvest', 'sell', 'buy_parcel', 'buy_animal', 'feed_animal', 'collect_animal', 'start_breeding', 'collect_offspring', ...millActions] },
    crop: { type: 'string', enum: crops },
    animalId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    partnerId: { type: 'string', pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
    species: { type: 'string', enum: animalSpecies },
    plotId: { type: 'string', enum: ['starter', 'expansion'] },
  },
  allOf: [
    { if: { properties: { action: { const: 'start_breeding' } } },
      then: { required: ['partnerId'] }, else: { not: { required: ['partnerId'] } } },
    { if: { properties: { action: { enum: ['collect_offspring', ...millActions] } } },
      then: { not: { anyOf: [{ required: ['crop'] }, { required: ['plotId'] }] } } },
    { if: { properties: { action: { enum: ['feed_animal', 'collect_animal', 'start_breeding'] } } },
      then: { required: ['animalId'], not: { anyOf: [{ required: ['crop'] }, { required: ['plotId'] }] } },
      else: { not: { required: ['animalId'] } } },
    { if: { properties: { action: { const: 'buy_animal' } } },
      then: { required: ['species'], not: { anyOf: [{ required: ['crop'] }, { required: ['plotId'] }] } },
      else: { not: { required: ['species'] } } },
    { if: { properties: { action: { const: 'harvest' } } }, then: { not: { required: ['crop'] } } },
    { if: { properties: { action: { const: 'sell' } } }, then: { required: ['crop'], not: { required: ['plotId'] } } },
    { if: { properties: { action: { const: 'buy_parcel' } } },
      then: { not: { anyOf: [{ required: ['crop'] }, { required: ['plotId'] }] } } },
  ],
} as const;

export function createApp(services?: FarmServices, webOrigin?: string) {
  const app = Fastify({
    logger: true,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  if (!services) return app;

  if (webOrigin) app.register(cors, { origin: webOrigin });

  app.register(async (farmApi) => {
    farmApi.addHook('preHandler', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
      if (!token) return reply.code(401).send({ code: 'unauthorized' });
      try {
        const player = await services.verifyToken(token);
        request.playerUid = player.uid;
      } catch {
        return reply.code(401).send({ code: 'unauthorized' });
      }
    });
    farmApi.decorateRequest('playerUid', '');
    farmApi.get('/farm', async (request) => services.store.load(request.playerUid));
    farmApi.post<{ Body: FarmCommand }>('/farm/commands', {
      schema: { body: commandSchema },
    }, async (request, reply) => {
      const result = await services.store.execute(request.playerUid, request.body);
      if (result.ok) return result.state;
      return reply.code(409).send({ code: result.code, state: result.state });
    });
  }, { prefix: '/v1' });
  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    playerUid: string;
  }
}

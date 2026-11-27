import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ status: 'ok' }));

try {
  await app.listen({
    host: '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

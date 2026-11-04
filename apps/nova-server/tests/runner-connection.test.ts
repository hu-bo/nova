import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { runnerRoutes } from '../src/modules/runners/runner.routes.js';
import type { RunnerService } from '../src/modules/runners/runner.service.js';
import type { RunnerTokenService } from '../src/modules/runners/runner-token.service.js';
import { registerErrorHandlers } from '../src/plugins/errors.js';

test('anonymous visitors can read connection metadata but cannot read Runner tokens', async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);
  registerErrorHandlers(app);
  await runnerRoutes(app, {} as RunnerTokenService, {} as RunnerService);
  const response = await app.inject({
    method: 'GET', url: '/runner-connection', headers: { host: 'nova.example' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { endpoint: 'ws://nova.example/runner/v1/connect' });
  const tokens = await app.inject({ method: 'GET', url: '/runner-tokens' });
  assert.equal(tokens.statusCode, 401);
});

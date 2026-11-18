import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { runnerRoutes } from '../src/modules/runners/runner.routes.js';
import type { RunnerService } from '../src/modules/runners/runner.service.js';
import type { RunnerTokenService } from '../src/modules/runners/runner-token.service.js';
import { registerErrorHandlers } from '../src/plugins/errors.js';
import { createCodingHarness } from '@nova/coding-harness';
import { createRemoteTools } from '@nova/tools/harness';
import { modelRouter, ToolFailureError, type AgentEvent, type PluginDefinition } from '@nnova/harness';
import { runnerToolContext } from '../src/modules/runs/runner-tool-context.js';
import { DomainError } from '../src/shared/domain-error.js';

test('offline Runner failures return to the model after thinking, including operations that can write', async (t) => {
  for (const name of ['list_dir', 'write_file']) await t.test(name, async () => {
    let modelSteps = 0;
    let connectionChecks = 0;
    const events: AgentEvent[] = [];
    const tools = createRemoteTools({
      createContext: (input) => runnerToolContext({
        async require() {
          connectionChecks++;
          assert.equal(modelSteps, 1);
          throw new DomainError('CONFLICT', 'Private connection details', { reason: 'RUNNER_OFFLINE' });
        },
      }, 'runner', 'owner', {
        workspaceId: 'workspace', signal: input.signal,
        executionId: input.executionId, idempotencyKey: input.idempotencyKey,
      }),
    });
    const model: PluginDefinition = {
      manifest: { id: 'offline-test-model', version: '1.0.0', apiVersion: 1, scope: 'kernel', requires: [], provides: [modelRouter] },
      setup(context) {
        context.provide(modelRouter, {
          id: 'test',
          async *stream(request) {
            modelSteps++;
            const result = request.messages.flatMap((message) => message.parts).find((part) => part.type === 'tool-result');
            if (!result) {
              assert.equal(connectionChecks, 0);
              assert.ok(request.messages.some((message) => message.role === 'user'));
              yield { type: 'thinking.delta', partId: 'thinking', text: '先检查项目工作区。' };
              const input = name === 'list_dir' ? {} : { path: 'test.txt', content: 'test' };
              yield { type: 'tool.call', callId: 'workspace-call', name, input };
              yield { type: 'message.completed', message: { role: 'assistant', parts: [
                { type: 'tool-call', callId: 'workspace-call', name, input },
              ] } };
              yield { type: 'finished', reason: 'tool-calls' };
              return;
            }
            assert.equal(result.status, 'failed');
            assert.match(JSON.stringify(result.value), /RUNNER_OFFLINE/);
            assert.match(JSON.stringify(result.value), /本次操作未执行/);
            assert.match(JSON.stringify(result.value), /"outcome":"known"/);
            assert.doesNotMatch(JSON.stringify(result.value), /Private connection details/);
            yield { type: 'text.delta', partId: 'answer', text: 'Runner 当前未连接，请启动或重新连接 Runner 后再试。' };
            yield { type: 'message.completed', message: { role: 'assistant', parts: [
              { type: 'text', text: 'Runner 当前未连接，请启动或重新连接 Runner 后再试。' },
            ] } };
            yield { type: 'finished', reason: 'stop' };
          },
        });
      },
    };
    const harness = await createCodingHarness({ model: { plugin: model, modelId: 'test' }, tools,
      onEvent: (event) => { events.push(event); } });
    try {
      const result = await harness.run({ role: 'user', parts: [{ type: 'text', text: '请检查这个项目' }] });
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(modelSteps, 2);
      assert.equal(connectionChecks, 1);
      assert.ok(events.some((event) => event.type === 'assistant.delta' && event.contentType === 'thinking'));
      assert.match(JSON.stringify(result), /Runner 当前未连接/);
    } finally { await harness.close(); }
  });
});

test('Runner tool context preserves failures other than offline', async () => {
  const failure = new DomainError('FORBIDDEN', 'Workspace denied');
  await assert.rejects(runnerToolContext({ async require() { throw failure; } }, 'runner', 'owner', {
    workspaceId: 'workspace', signal: new AbortController().signal,
  }), (error) => error === failure && !(error instanceof ToolFailureError));
});

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

test('connection metadata advertises wss:// when the proxy forwarded an https protocol', async (t) => {
  // 与 app.ts 相同的生产形态: Nginx 终结 TLS 后重写 x-forwarded-proto, Fastify 需 trustProxy 才采信。
  const app = Fastify({ logger: false, trustProxy: true });
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('principal', null);
  registerErrorHandlers(app);
  await runnerRoutes(app, {} as RunnerTokenService, {} as RunnerService);
  const response = await app.inject({
    method: 'GET', url: '/runner-connection',
    headers: { host: 'nova.8and1.cn', 'x-forwarded-proto': 'https' },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { endpoint: 'wss://nova.8and1.cn/runner/v1/connect' });
});

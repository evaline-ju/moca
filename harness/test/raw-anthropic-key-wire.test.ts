import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { complete, getModel } from '@earendil-works/pi-ai';
import { applyModelGateway } from '../src/run-turn';

/**
 * What actually reaches the wire for a per-user inference credential (#362 item 3, #368 scope 1).
 *
 * model-gateway.test.ts asserts the model OBJECT applyModelGateway returns; this drives pi-ai's real
 * Anthropic client against a local stand-in for api.anthropic.com and records the request headers,
 * so the SDK's own header merging is part of what is tested.
 */
describe('a raw Anthropic API key on the wire', () => {
  let server: Server;
  let seen: IncomingHttpHeaders | undefined;
  let baseUrl: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    seen = undefined;
    server = createServer((req, res) => {
      seen = req.headers;
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('is sent as x-api-key, which is the only header api.anthropic.com reads an API key from', async () => {
    const key = 'sk-ant-api03-test-not-a-real-key'; // notsecret
    const model = applyModelGateway(getModel('anthropic', 'claude-haiku-4-5'), {
      anthropicBaseUrl: baseUrl,
      upstreamCredential: { mode: 'direct', value: key, header: 'x-api-key' },
    });
    await complete(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });

    expect(seen).toBeDefined();
    expect(seen!['x-api-key']).toBe(key);
    expect(seen!.authorization).toBeUndefined();
  });

  it('a gateway token with no header named still goes as Bearer, with no x-api-key', async () => {
    const model = applyModelGateway(getModel('anthropic', 'claude-haiku-4-5'), {
      anthropicBaseUrl: baseUrl,
      upstreamCredential: { mode: 'direct', value: 'gw-token' }, // notsecret
    });
    await complete(model, { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] });

    expect(seen!.authorization).toBe('Bearer gw-token'); // notsecret
    expect(seen!['x-api-key']).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/errors.js';
import type { PutCredentialRequest, SessionSummary } from '../src/api/types.js';
import {
  cmdCredentialAdd,
  cmdCredentialDelete,
  cmdCredentials,
  cmdSessionDelete,
  cmdSessions,
  type CredentialAddOptions,
  type Io,
} from '../src/headless.js';
import { credential, fakeControlPlane } from './helpers/fakes.js';
import { testRuntime } from './helpers/runtime.js';

function io(): Io & { stdout: string; stderr: string[] } {
  const o = {
    stdout: '',
    stderr: [] as string[],
    out: (s: string) => void (o.stdout += s),
    err: (s: string) => void o.stderr.push(s),
  };
  return o;
}

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    owner: 'github:1',
    tenant: 't',
    createdAt: Date.UTC(2026, 8, 30, 9, 15),
    state: 'active',
    lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
    turns: 2,
    ...over,
  };
}

const loggedOut = { auth: null };

describe('cmdSessions', () => {
  it('follows every page and prints a table with local titles', async () => {
    const listSessions = vi.fn(async (opts?: { cursor?: number }) =>
      opts?.cursor === undefined
        ? { sessions: [summary('s-1')], nextCursor: 7 }
        : { sessions: [summary('s-2', { lastTurnAt: null, turns: 0 })], nextCursor: null },
    );
    const rt = testRuntime({ cp: fakeControlPlane({ listSessions }) });
    rt.transcripts!.rename('s-1', 'fix \u001b]52;c;aGk=\u0007the build');
    const o = io();
    expect(await cmdSessions(rt, o, { json: false })).toBe(0);
    expect(listSessions.mock.calls.map((c) => c[0]?.cursor)).toEqual([undefined, 7]);
    const lines = o.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^ID\s+CREATED \(UTC\)\s+LAST TURN \(UTC\)\s+TURNS\s+TITLE$/);
    expect(lines[1]).toMatch(/^s-1\s+2026-09-30 09:15\s+2026-09-30 09:20\s+2\s+fix the build$/);
    expect(lines[2]).toMatch(/^s-2\s+2026-09-30 09:15\s+-\s+0\s*$/);
  });

  it('prints the documented --json shape', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => ({
          sessions: [summary('s-1'), summary('s-2')],
          nextCursor: null,
        }),
      }),
    });
    rt.transcripts!.rename('s-1', 'fix the build');
    const o = io();
    expect(await cmdSessions(rt, o, { json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      sessions: [
        {
          sessionId: 's-1',
          title: 'fix the build',
          state: 'active',
          createdAt: Date.UTC(2026, 8, 30, 9, 15),
          lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
          turns: 2,
        },
        {
          sessionId: 's-2',
          title: null,
          state: 'active',
          createdAt: Date.UTC(2026, 8, 30, 9, 15),
          lastTurnAt: Date.UTC(2026, 8, 30, 9, 20),
          turns: 2,
        },
      ],
    });
    expect(o.stdout.endsWith('\n')).toBe(true);
  });

  it('keeps stdout empty with no sessions, and prints an empty list with --json', async () => {
    const o = io();
    expect(await cmdSessions(testRuntime(), o, { json: false })).toBe(0);
    expect(o.stdout).toBe('');
    expect(o.stderr).toContain('no sessions');
    const j = io();
    expect(await cmdSessions(testRuntime(), j, { json: true })).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual({ sessions: [] });
  });

  it('stops with an error when the control plane repeats a cursor', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => ({ sessions: [summary('s-1')], nextCursor: 3 }),
      }),
    });
    const o = io();
    expect(await cmdSessions(rt, o, { json: false })).toBe(1);
    expect(o.stdout).toBe('');
    expect(o.stderr.join('\n')).toContain('repeated');
  });

  it('exits 2 when not logged in, and 1 with a readable message when the request fails', async () => {
    const o = io();
    expect(await cmdSessions(testRuntime(loggedOut), o, { json: false })).toBe(2);
    expect(o.stderr).toContain('not logged in — run `mocactl login` first');
    const f = io();
    const rt = testRuntime({
      cp: fakeControlPlane({
        listSessions: async () => {
          throw new ApiError('control-plane', 401, 'token_expired');
        },
      }),
    });
    expect(await cmdSessions(rt, f, { json: false })).toBe(1);
    expect(f.stderr.join('\n')).toContain('mocactl login');
  });
});

describe('cmdSessionDelete', () => {
  it('deletes the session and its local history', async () => {
    const rt = testRuntime();
    rt.transcripts!.rename('s-1', 'old');
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-1', json: false })).toBe(0);
    expect((rt.cp as ReturnType<typeof fakeControlPlane>).calls).toContain('deleteSession');
    expect(rt.transcripts!.has('s-1')).toBe(false);
    expect(o.stderr).toContain('deleted session s-1');
    expect(o.stdout).toBe('');
  });

  it('says when the deletion finishes in the background, and prints JSON', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ deleteSession: async () => 'accepted' }) });
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-1', json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({ sessionId: 's-1', status: 'accepted' });
    expect(o.stderr.join('\n')).toContain('finishes in the background');
  });

  it('exits 1 when the session is not there', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        deleteSession: async () => {
          throw new ApiError('control-plane', 404, 'session_not_found');
        },
      }),
    });
    const o = io();
    expect(await cmdSessionDelete(rt, o, { id: 's-x', json: false })).toBe(1);
    expect(o.stderr.join('\n')).toContain('no longer exists');
  });
});

describe('cmdCredentials', () => {
  const creds = [
    credential('anthropic', {
      kind: 'api-key',
      destination: { hosts: ['api.anthropic.com'] },
      endpoint: 'https://api.anthropic.com',
    }),
    credential('gh\u001b[8m', {
      consumer: 'sandbox-egress',
      destination: { hosts: ['github.com', 'api.github.com'] },
      endpoint: null,
    }),
  ];

  it('prints a terminal-safe table', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => creds }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: false })).toBe(0);
    const lines = o.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+CONSUMER\s+HOSTS\s+ENDPOINT$/);
    expect(lines[1]).toMatch(
      /^anthropic\s+api-key\s+inference\s+api\.anthropic\.com\s+https:\/\/api\.anthropic\.com$/,
    );
    expect(lines[2]).toMatch(/^gh\s+bearer\s+sandbox-egress\s+github\.com,api\.github\.com\s+-$/);
    expect(o.stdout).not.toContain('\u001b');
  });

  it('prints the documented --json shape', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => creds }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: true })).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({
      credentials: [
        {
          name: 'anthropic',
          kind: 'api-key',
          consumer: 'inference',
          hosts: ['api.anthropic.com'],
          endpoint: 'https://api.anthropic.com',
        },
        {
          name: 'gh\u001b[8m',
          kind: 'bearer',
          consumer: 'sandbox-egress',
          hosts: ['github.com', 'api.github.com'],
          endpoint: null,
        },
      ],
    });
  });

  it('keeps stdout empty with no credentials', async () => {
    const rt = testRuntime({ cp: fakeControlPlane({ listCredentials: async () => [] }) });
    const o = io();
    expect(await cmdCredentials(rt, o, { json: false })).toBe(0);
    expect(o.stdout).toBe('');
    expect(o.stderr).toContain('no credentials');
  });
});

describe('cmdCredentialAdd', () => {
  function adding(over: Partial<CredentialAddOptions> = {}): CredentialAddOptions {
    return {
      name: 'anthropic',
      kind: 'api-key',
      consumer: 'inference',
      hosts: ['api.anthropic.com'],
      endpoint: 'https://api.anthropic.com',
      json: false,
      stdinIsTTY: false,
      readStdin: async () => 'sk-ant-api03-secret\n',
      ...over,
    };
  }

  function recording() {
    const puts: Array<{ name: string; req: PutCredentialRequest }> = [];
    const rt = testRuntime({
      cp: fakeControlPlane({ putCredential: async (name, req) => void puts.push({ name, req }) }),
    });
    return { rt, puts };
  }

  it('stores the secret read from stdin, without its trailing newline', async () => {
    const { rt, puts } = recording();
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding())).toBe(0);
    expect(puts).toEqual([
      {
        name: 'anthropic',
        req: {
          kind: 'api-key',
          consumer: 'inference',
          destination: { hosts: ['api.anthropic.com'] },
          endpoint: 'https://api.anthropic.com',
          secret: { key: 'sk-ant-api03-secret' },
        },
      },
    ]);
    expect(o.stderr).toContain('stored credential anthropic');
    expect(o.stdout).toBe('');
  });

  it('prints JSON with --json', async () => {
    const { rt } = recording();
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding({ json: true }))).toBe(0);
    expect(JSON.parse(o.stdout)).toEqual({ name: 'anthropic', status: 'stored' });
  });

  it('reads key=value lines for a kind with several secret fields', async () => {
    const { rt, puts } = recording();
    const o = io();
    const opts = adding({
      name: 'registry',
      kind: 'basic',
      consumer: 'sandbox-egress',
      hosts: ['ghcr.io'],
      endpoint: undefined,
      readStdin: async () => 'username=ada\npassword=p=ss,word\n\n',
    });
    expect(await cmdCredentialAdd(rt, o, opts)).toBe(0);
    expect(puts[0]!.req.secret).toEqual({ username: 'ada', password: 'p=ss,word' });
    expect(puts[0]!.req).not.toHaveProperty('endpoint');
  });

  it.each([
    ['a terminal on stdin', { stdinIsTTY: true }, 'pipe the secret'],
    ['an empty secret', { readStdin: async () => '\n' }, 'no secret on stdin'],
    ['a multi-line secret', { readStdin: async () => 'one\ntwo\n' }, 'one line'],
    [
      'a missing field',
      { kind: 'basic', consumer: 'sandbox-egress', readStdin: async () => 'username=ada\n' },
      'password=',
    ],
    ['no host', { hosts: [] }, 'at least one host'],
    ['a bad name', { name: 'Bad_Name' }, 'name:'],
  ] as Array<[string, Partial<CredentialAddOptions>, string]>)(
    'exits 2 without storing anything for %s',
    async (_label, over, message) => {
      const { rt, puts } = recording();
      const o = io();
      expect(await cmdCredentialAdd(rt, o, adding(over))).toBe(2);
      expect(puts).toEqual([]);
      expect(o.stderr.join('\n')).toContain(message);
    },
  );

  it('names the fix for a mis-shaped inference secret without echoing it', async () => {
    const { rt, puts } = recording();
    const o = io();
    const opts = adding({ readStdin: async () => 'sk-ant-oat01-very-secret' });
    expect(await cmdCredentialAdd(rt, o, opts)).toBe(2);
    expect(puts).toEqual([]);
    expect(o.stderr.join('\n')).toContain('OAuth tokens');
    expect(o.stderr.join('\n')).not.toContain('very-secret');
  });

  it('exits 1 when the control plane rejects it', async () => {
    const rt = testRuntime({
      cp: fakeControlPlane({
        putCredential: async () => {
          throw new ApiError('control-plane', 400, 'bad_request', 'unknown kind');
        },
      }),
    });
    const o = io();
    expect(await cmdCredentialAdd(rt, o, adding())).toBe(1);
    expect(o.stderr.join('\n')).toContain('unknown kind');
  });

  it('exits 2 when not logged in, before reading stdin', async () => {
    const readStdin = vi.fn(async () => 'x');
    const o = io();
    expect(await cmdCredentialAdd(testRuntime(loggedOut), o, adding({ readStdin }))).toBe(2);
    expect(readStdin).not.toHaveBeenCalled();
  });
});

describe('cmdCredentialDelete', () => {
  it('deletes the credential', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const rt = testRuntime({ cp: fakeControlPlane({ deleteCredential }) });
    const o = io();
    expect(await cmdCredentialDelete(rt, o, { name: 'anthropic', json: true })).toBe(0);
    expect(deleteCredential).toHaveBeenCalledWith('anthropic');
    expect(JSON.parse(o.stdout)).toEqual({ name: 'anthropic', status: 'deleted' });
  });
});

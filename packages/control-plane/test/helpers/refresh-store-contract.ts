import { afterEach, describe, expect, it } from 'vitest';
import {
  isRefreshTokenShape,
  type AuditFields,
  type RefreshPolicy,
  type RefreshStore,
} from '../../src/refresh-store.js';

export type MakeStore = (policy: RefreshPolicy) => Promise<{
  store: RefreshStore;
  audit(): Promise<AuditFields[]>;
  done(): Promise<void>;
}>;

const S = 1000;
const DAY = 86_400 * S;
const T0 = 1_757_000_000_000;
const POLICY: RefreshPolicy = { idleTtlS: 30 * 86_400, maxTtlS: 90 * 86_400, graceS: 30 };

/** The decisions in order, for assertions that read like the spec's step list. */
const decisions = (a: AuditFields[]) => a.map((e) => [e.decision, e.reason ?? ''].join(':'));

/**
 * The behaviour B14 spec §4.3 pins, run against every RefreshStore. The Lua script and the
 * TypeScript fake disagreeing is the failure mode this exists for: handler tests run on the fake,
 * production on the script.
 */
export function refreshStoreContract(name: string, make: MakeStore): void {
  describe(`RefreshStore contract: ${name}`, () => {
    let h: Awaited<ReturnType<MakeStore>>;
    const setup = async (policy: RefreshPolicy = POLICY) => (h = await make(policy));
    afterEach(async () => h?.done());
    const login = (subject = 'github:1', nowMs = T0) =>
      h.store.issue({ subject, displayName: 'Ada', label: 'laptop', nowMs });

    it('issues an mrt_ token, caps it at the absolute limit, and audits refresh_issued', async () => {
      await setup();
      const i = await login();
      expect(isRefreshTokenShape(i.refreshToken)).toBe(true);
      expect(i.absExpS).toBe(Math.floor((T0 + 90 * DAY) / 1000));
      expect(await h.audit()).toEqual([
        { ts: String(T0), subject: 'github:1', decision: 'refresh_issued', family: i.family },
      ]);
    });

    it('rotates: a new token each time, the old one superseded', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0 + 60 * S);
      expect(r1).toMatchObject({
        ok: true,
        family: i.family,
        subject: 'github:1',
        graceReplay: false,
      });
      if (!r1.ok) throw new Error('unreachable');
      expect(r1.refreshToken).not.toBe(i.refreshToken);
      expect(r1.displayName).toBe('Ada');
      const r2 = await h.store.rotate(r1.refreshToken, T0 + 120 * S);
      expect(r2.ok).toBe(true);
      expect(decisions(await h.audit())).toEqual([
        'refresh_issued:',
        'refresh_rotated:',
        'refresh_rotated:',
      ]);
    });

    it('answers a replay of the previous token inside the grace window with the SAME successor', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0);
      const again = await h.store.rotate(i.refreshToken, T0 + 10 * S);
      expect(again).toMatchObject({ ok: true, graceReplay: true });
      if (!r1.ok || !again.ok) throw new Error('unreachable');
      expect(again.refreshToken).toBe(r1.refreshToken);
      // The family is still live: the successor keeps working.
      expect((await h.store.rotate(r1.refreshToken, T0 + 20 * S)).ok).toBe(true);
      expect(decisions(await h.audit())).toContain('refresh_rotated:grace_replay');
    });

    it('revokes the family when the previous token comes back after the grace window', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      expect(await h.store.rotate(i.refreshToken, T0 + 31 * S)).toEqual({
        ok: false,
        reason: 'reuse',
      });
      // Both holders are now out: the legitimate successor is refused too.
      expect(await h.store.rotate(r1.refreshToken, T0 + 32 * S)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect(decisions(await h.audit()).slice(-2)).toEqual([
        'refresh_reuse_detected:',
        'refresh_refused:revoked',
      ]);
    });

    it('treats a token two generations old as reuse even inside the grace window', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      await h.store.rotate(r1.refreshToken, T0 + 1 * S);
      expect(await h.store.rotate(i.refreshToken, T0 + 2 * S)).toEqual({
        ok: false,
        reason: 'reuse',
      });
    });

    it('slides the idle limit on use and refuses after it lapses', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0 + 29 * DAY);
      expect(r1.ok).toBe(true);
      if (!r1.ok) throw new Error('unreachable');
      // 29 days after the LAST use is still fine; 30 is not.
      const r2 = await h.store.rotate(r1.refreshToken, T0 + 58 * DAY);
      expect(r2.ok).toBe(true);
      if (!r2.ok) throw new Error('unreachable');
      expect(await h.store.rotate(r2.refreshToken, T0 + 88 * DAY)).toEqual({
        ok: false,
        reason: 'idle_expired',
      });
    });

    it('never extends past the absolute limit, however often it is used', async () => {
      await setup({ idleTtlS: 10 * 86_400, maxTtlS: 15 * 86_400, graceS: 30 });
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0 + 9 * DAY);
      if (!r1.ok) throw new Error('unreachable');
      expect(await h.store.rotate(r1.refreshToken, T0 + 15 * DAY)).toEqual({
        ok: false,
        reason: 'abs_expired',
      });
    });

    it('refuses an unknown token and audits it without a subject', async () => {
      await setup();
      expect(await h.store.rotate('mrt_' + 'A'.repeat(43), T0)).toEqual({
        ok: false,
        reason: 'unknown',
      });
      expect(await h.audit()).toEqual([
        {
          ts: String(T0),
          subject: '-',
          decision: 'refresh_refused',
          family: '-',
          reason: 'unknown',
        },
      ]);
    });

    it('revokes by any token of the family, idempotently, auditing the transition once', async () => {
      await setup();
      const i = await login();
      const r1 = await h.store.rotate(i.refreshToken, T0);
      if (!r1.ok) throw new Error('unreachable');
      expect(await h.store.revoke(i.refreshToken, T0 + S)).toBe(true); // a superseded token still names it
      expect(await h.store.revoke(r1.refreshToken, T0 + 2 * S)).toBe(true);
      expect(await h.store.rotate(r1.refreshToken, T0 + 3 * S)).toEqual({
        ok: false,
        reason: 'revoked',
      });
      expect(decisions(await h.audit()).filter((d) => d.startsWith('refresh_revoked'))).toEqual([
        'refresh_revoked:logout',
      ]);
    });

    it('answers false, and audits nothing, when revoking a token nobody issued', async () => {
      await setup();
      expect(await h.store.revoke('mrt_' + 'B'.repeat(43), T0)).toBe(false);
      expect(await h.audit()).toEqual([]);
    });

    it('revokeAllFor revokes every family of one subject and none of another', async () => {
      await setup();
      const a1 = await login('github:1');
      const a2 = await login('github:1');
      const b = await login('github:2');
      expect(await h.store.revokeAllFor('github:1', T0 + S)).toBe(2);
      expect((await h.store.rotate(a1.refreshToken, T0 + 2 * S)).ok).toBe(false);
      expect((await h.store.rotate(a2.refreshToken, T0 + 2 * S)).ok).toBe(false);
      expect((await h.store.rotate(b.refreshToken, T0 + 2 * S)).ok).toBe(true);
      const revoked = (await h.audit()).filter((e) => e.decision === 'refresh_revoked');
      expect(revoked.map((e) => [e.family, e.reason]).sort()).toEqual(
        [
          [a1.family, 'logout_all'],
          [a2.family, 'logout_all'],
        ].sort(),
      );
      // Already-revoked families are not counted twice.
      expect(await h.store.revokeAllFor('github:1', T0 + 3 * S)).toBe(0);
    });

    it('never writes a token or a hash into the audit stream', async () => {
      await setup();
      const i = await login();
      await h.store.rotate(i.refreshToken, T0);
      await h.store.rotate('mrt_' + 'C'.repeat(43), T0);
      const text = JSON.stringify(await h.audit());
      expect(text).not.toMatch(/mrt_/);
      expect(text).not.toMatch(/[0-9a-f]{64}/);
    });
  });
}

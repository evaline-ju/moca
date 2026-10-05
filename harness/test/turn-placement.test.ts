import { describe, expect, it } from 'vitest';
import { placementFrame, withPlacement, type TurnResult } from '../src/run-turn.js';

const result: TurnResult = { sessionId: 's', response: 'ok', stopReason: 'stop' };

describe('placementFrame', () => {
  it('is null with no placement, or with no reset', () => {
    expect(placementFrame('s', undefined)).toBeNull();
    expect(placementFrame('s', { sandboxId: 'm-0', tier: 'microvm' })).toBeNull();
  });
  it('is a workspace_reset frame after a fallback', () => {
    expect(
      placementFrame('s', {
        sandboxId: 'm-1',
        tier: 'microvm',
        workspaceReset: { from: 'm-0', reason: 'detached' },
      }),
    ).toEqual({
      type: 'workspace_reset',
      sessionId: 's',
      from: 'm-0',
      tier: 'microvm',
      reason: 'detached',
    });
  });
});

describe('withPlacement', () => {
  it('leaves the result untouched with no placement', () => {
    expect(withPlacement(result, undefined)).toEqual(result);
  });
  it('adds where the turn ran, and the reset if any', () => {
    expect(
      withPlacement(result, {
        sandboxId: 'm-1',
        tier: 'microvm',
        workspaceReset: { from: 'm-0', reason: 'retiered' },
      }),
    ).toEqual({
      ...result,
      sandbox: { id: 'm-1', tier: 'microvm', workspaceReset: { from: 'm-0', reason: 'retiered' } },
    });
  });
});

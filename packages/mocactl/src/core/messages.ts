import { ApiError, classify } from '../api/errors.js';
import { sanitizeRemote } from './sanitize.js';

/**
 * The one sentence a user sees for an error, headless or in the TUI (spec §8.1). Error messages
 * carry server text, so the result is always terminal-safe.
 */
export function describeError(err: unknown): string {
  return sanitizeRemote(describe(err));
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    const action = classify(err);
    switch (action.kind) {
      case 'login':
        return 'your login has expired — run `mocactl login` (or restart mocactl) to log in again';
      case 'harness-token-rejected':
        return 'the harness rejected the session token — run `mocactl doctor`';
      case 'session-gone':
        return 'that session no longer exists, or is not yours';
      case 'bundle-expired':
        return "this session's config bundle is gone (expired or never uploaded) — promote the same directory again; if it changed, start a new session";
      case 'bundle-quota':
        return "the control plane's config-bundle storage is full for your account or the deployment — free yours with `mocactl bundles delete DIGEST`, or ask the operator";
      case 'endpoint-unresolved':
        return `the inference credential has no gateway endpoint (${action.message}) — edit it in /credentials`;
      case 'operator-misconfigured':
        return `the control plane cannot log anyone in until its operator fixes it — ${action.message}`;
      case 'retry-after':
        return `the harness has no capacity — retry in ${action.seconds}s`;
      case 'unavailable':
        return `the ${action.source === 'harness' ? 'harness' : 'control plane'} is unavailable — try again shortly`;
      case 'connection':
        return `cannot reach the ${action.source === 'harness' ? 'harness' : 'control plane'}: ${action.message}`;
      case 'show':
        return action.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

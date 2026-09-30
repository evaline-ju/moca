/**
 * The only value the harness ever writes into `ANTHROPIC_API_KEY` (MI1 §5 R2, P5 §3.3).
 *
 * Pi resolves the request key BY PROVIDER NAME, so the variable must exist whenever a Bearer token is
 * in play, or pi throws "No API key found" before any request is made. The value is identical for
 * every caller, so it asserts no identity; applyModelGateway sends `x-api-key: null` alongside the
 * Bearer header, so it never reaches the wire as auth. It lives in its own module so tests that mock
 * `@moca/harness/run-turn` wholesale still resolve it.
 */
export const AMBIENT_KEY_SENTINEL = 'sh-unused-see-authorization-header';

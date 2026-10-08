/**
 * Strip trailing "/" from a path with a linear scan.
 *
 * Deliberately not `/\/+$/`: CodeQL flags that as polynomial (js/polynomial-redos), and callers pass
 * caller-controlled input -- workspaceRef arrives on the LeafEnvelope straight off the request body,
 * podCwd comes from deployment config. The regex retries from every position on a long run of
 * slashes, so `/w` + 100k slashes + a non-slash costs ~15s of CPU per call; this costs ~0.005ms.
 *
 * One shared implementation on purpose: 8efd213 rewrote the regex in buildSolvePrompt but missed
 * the copy in buildLeafPrompt, and #408 reintroduced it in sessionPodCwd. One copy cannot be missed.
 */
export function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return path.slice(0, end);
}

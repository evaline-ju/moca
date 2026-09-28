/**
 * `s` without its trailing slashes. A loop, not `/\/+$/`: that regex is quadratic on a long run of
 * slashes that is not at the end (CodeQL js/polynomial-redos), and these strings come from the
 * user, the environment and the control plane.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return s.slice(0, end);
}

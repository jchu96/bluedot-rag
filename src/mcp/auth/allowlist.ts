/**
 * GitHub username allowlist check for MCP access.
 *
 * `allowedCsv` is a comma-separated list from the `ALLOWED_USERS` env var.
 * Matching is case-insensitive; whitespace around entries is ignored.
 */
export function isAllowed(username: string, allowedCsv: string | undefined): boolean {
  if (!username) return false;
  if (!allowedCsv) return false;

  const normalized = username.trim().toLowerCase();
  if (!normalized) return false;

  const allowed = allowedCsv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  return allowed.includes(normalized);
}

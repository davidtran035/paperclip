import postgres from "postgres";

/**
 * postgres.js cannot express a Unix socket in a URL, so a libpq-style `?host=/absolute/dir` is
 * translated into its `path` option. Any other URL passes through unchanged.
 */
export function resolvePostgresTarget(url: string): { url: string; path?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url };
  }
  const socketDir = parsed.searchParams.get("host");
  if (!socketDir?.startsWith("/")) return { url };
  parsed.searchParams.delete("host");
  return { url: parsed.toString(), path: `${socketDir}/.s.PGSQL.${parsed.port || "5432"}` };
}

export function openPostgres(url: string, options?: postgres.Options<Record<string, never>>) {
  const target = resolvePostgresTarget(url);
  return postgres(target.url, target.path ? { ...options, path: target.path } : options);
}

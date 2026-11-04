import { isAbsolute } from "node:path";

/** Reads the socket directory that removes the embedded database from every TCP interface. */
export function embeddedPostgresSocketDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const socketDir = env.PAPERCLIP_EMBEDDED_POSTGRES_SOCKET_DIR?.trim();
  if (!socketDir) return null;
  if (!isAbsolute(socketDir)) {
    throw new Error("PAPERCLIP_EMBEDDED_POSTGRES_SOCKET_DIR must be an absolute path");
  }
  return socketDir;
}

export function embeddedPostgresFlags(socketDir: string | null): string[] {
  if (!socketDir) return [];
  return [
    "-c", "listen_addresses=",
    "-c", `unix_socket_directories=${socketDir}`,
    "-c", "unix_socket_permissions=0700",
  ];
}

export function embeddedPostgresUrl(socketDir: string | null, port: number, database: string): string {
  return socketDir
    ? `postgres://paperclip:paperclip@localhost:${port}/${database}?host=${encodeURIComponent(socketDir)}`
    : `postgres://paperclip:paperclip@127.0.0.1:${port}/${database}`;
}

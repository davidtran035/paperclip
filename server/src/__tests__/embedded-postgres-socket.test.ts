import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  companies,
  createDb,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import {
  embeddedPostgresFlags,
  embeddedPostgresSocketDir,
  embeddedPostgresUrl,
} from "../embedded-postgres-network.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

describe("embedded postgres network settings", () => {
  it("keeps TCP settings when no socket directory is configured", () => {
    expect(embeddedPostgresSocketDir({})).toBeNull();
    expect(embeddedPostgresFlags(null)).toEqual([]);
    expect(embeddedPostgresUrl(null, 54329, "paperclip")).toBe("postgres://paperclip:paperclip@127.0.0.1:54329/paperclip");
  });

  it("disables TCP when a socket directory is configured", () => {
    expect(embeddedPostgresFlags("/run/db")).toEqual(expect.arrayContaining(["listen_addresses=", "unix_socket_permissions=0700"]));
    expect(embeddedPostgresUrl("/run/db", 54329, "paperclip")).toBe(
      "postgres://paperclip:paperclip@localhost:54329/paperclip?host=%2Frun%2Fdb",
    );
  });

  it("rejects a relative socket directory", () => {
    expect(() => embeddedPostgresSocketDir({ PAPERCLIP_EMBEDDED_POSTGRES_SOCKET_DIR: "db" })).toThrow(/absolute/);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("embedded postgres on a Unix socket", () => {
  const root = mkdtempSync(join(tmpdir(), "pg-sock-"));
  const socketDir = join(root, "s");
  const port = 55000 + Math.floor(Math.random() * 4000);
  const url = embeddedPostgresUrl(socketDir, port, "paperclip");
  let instance: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> } | null = null;

  beforeAll(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(socketDir, { mode: 0o700 });
    const moduleName = "embedded-postgres";
    const { default: EmbeddedPostgres } = await import(moduleName);
    instance = new EmbeddedPostgres({
      databaseDir: join(root, "d"),
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      postgresFlags: embeddedPostgresFlags(socketDir),
      onLog: () => {},
      onError: () => {},
    });
    await instance!.initialise();
    await instance!.start();
    await ensurePostgresDatabase(embeddedPostgresUrl(socketDir, port, "postgres"), "paperclip");
  }, 120_000);

  afterAll(async () => {
    await instance?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts no TCP connection and keeps its socket private", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    expect(outcome).toBe("ECONNREFUSED");
    expect(statSync(socketDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(socketDir, `.s.PGSQL.${port}`)).mode & 0o077).toBe(0);
  });

  it("runs migrations, then backs up and restores through the socket", async () => {
    await applyPendingMigrations(url);
    const db = createDb(url);
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Kept by backup", issuePrefix: `S${id.slice(0, 6).toUpperCase()}` });

    const backupDir = join(root, "b");
    const backup = await runDatabaseBackup({
      connectionString: url,
      backupDir,
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      filenamePrefix: "paperclip",
    });
    expect(existsSync(backup.backupFile)).toBe(true);
    expect(readdirSync(backupDir).length).toBeGreaterThan(0);

    await db.delete(companies).where(eq(companies.id, id));
    await runDatabaseRestore({ connectionString: url, backupFile: backup.backupFile });

    const restored = createDb(url);
    await expect(
      restored.select({ name: companies.name }).from(companies).where(eq(companies.id, id)),
    ).resolves.toEqual([{ name: "Kept by backup" }]);
  }, 240_000);
});

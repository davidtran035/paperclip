import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeAdmissions,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("caller wake admission", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let workDir = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-wake-admission-");
    db = createDb(tempDb.connectionString);
    workDir = mkdtempSync(join(tmpdir(), "wake-admission-"));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** An agent whose only side effect is one line in a file, so each execution can be counted. */
  async function setup(status = "todo") {
    const marker = join(workDir, `${randomUUID()}.log`);
    const [company] = await db
      .insert(companies)
      .values({ name: `Wake ${randomUUID()}`, issuePrefix: `W${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: `Reviewer ${randomUUID()}`,
        role: "qa",
        status: "idle",
        permissions: {},
        adapterType: "process",
        adapterConfig: { command: "/bin/sh", args: ["-c", `echo run >> ${marker}`], cwd: workDir, timeoutSec: 30 },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      })
      .returning();
    const issueId = await createIssue(company!.id, agent!.id, status);
    return { companyId: company!.id, agentId: agent!.id, issueId, marker };
  }

  async function createIssue(companyId: string, agentId: string, status: string) {
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Review", status, assigneeAgentId: agentId })
      .returning();
    return issue!.id;
  }

  function wake(agentId: string, issueId: string, operationKey: string | null) {
    return heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "review",
      payload: { issueId },
      idempotencyKey: operationKey,
      callerAdmission: { operationKey },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {},
    });
  }

  async function settled(agentId: string) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("runs did not settle");
  }

  const executions = (marker: string) =>
    existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
  // A run that leaves its task open earns one automatic continuation, so caller wakes are counted by source.
  const callerRuns = (agentId: string) =>
    db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.invocationSource, "on_demand")))
      .then((rows) => rows.length);
  const runs = (agentId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  const refusals = (agentId: string, reason: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, reason)));
  const issueStatus = (issueId: string) =>
    db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!.status);

  it("executes one run for concurrent and retried requests of the same operation", async () => {
    const { agentId, issueId, marker } = await setup();

    const results = await Promise.all(Array.from({ length: 5 }, () => wake(agentId, issueId, "op-1")));
    await settled(agentId);
    await expect(wake(agentId, issueId, "op-1")).resolves.toBeNull();
    await settled(agentId);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(executions(marker)).toBeGreaterThan(0);
    expect(await callerRuns(agentId)).toBe(1);
    expect(await refusals(agentId, "duplicate_operation_key")).toHaveLength(5);
    expect(
      await db.select().from(agentWakeAdmissions).where(eq(agentWakeAdmissions.agentId, agentId)),
    ).toHaveLength(1);
  }, 60_000);

  it("treats the same key on another task as a separate operation", async () => {
    const { companyId, agentId, issueId, marker } = await setup();
    const otherIssueId = await createIssue(companyId, agentId, "todo");

    await wake(agentId, issueId, "op-1");
    await settled(agentId);
    await wake(agentId, otherIssueId, "op-1");
    await settled(agentId);

    expect(await callerRuns(agentId)).toBe(2);
  }, 60_000);

  it.each(["blocked", "done", "cancelled"])("refuses to restart a %s task, with or without a new key", async (status) => {
    const { agentId, issueId, marker } = await setup(status);

    await expect(wake(agentId, issueId, "op-new")).resolves.toBeNull();
    await expect(wake(agentId, issueId, null)).resolves.toBeNull();
    await settled(agentId);

    expect(executions(marker)).toBe(0);
    expect(await runs(agentId)).toHaveLength(0);
    expect(await issueStatus(issueId)).toBe(status);
    expect(await refusals(agentId, "issue_reopen_required")).toHaveLength(2);
  }, 60_000);

  it("runs again only after the task is reopened and with a new operation key", async () => {
    const { agentId, issueId, marker } = await setup("blocked");

    await wake(agentId, issueId, "op-1");
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    await wake(agentId, issueId, "op-2");
    await settled(agentId);
    expect(await callerRuns(agentId)).toBe(1);

    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    await expect(wake(agentId, issueId, "op-2")).resolves.toBeNull();
    await settled(agentId);
    expect(await callerRuns(agentId)).toBe(1);
  }, 60_000);

  it("keeps the operation key usable when the wake was rejected", async () => {
    const { agentId, issueId, marker } = await setup();

    await expect(
      heartbeatService(db).wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        failedRunId: randomUUID(),
        payload: { issueId },
        callerAdmission: { operationKey: "op-1" },
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        contextSnapshot: {},
      }),
    ).rejects.toThrow();
    expect(
      await db.select().from(agentWakeAdmissions).where(eq(agentWakeAdmissions.agentId, agentId)),
    ).toHaveLength(0);

    await wake(agentId, issueId, "op-1");
    await settled(agentId);
    expect(executions(marker)).toBeGreaterThan(0);
  }, 60_000);
});

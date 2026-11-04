import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeAgentHire } from "../services/agent-hiring.js";
import { authorizationService } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const GOVERNANCE_ACTIONS = [
  "agent_config:update",
  "agent_instructions:update",
  "skill_config:update",
  "agents:configure",
] as const;
const AGENT_IDENTITIES = ["agent_key", "agent_jwt"] as const;

describeEmbeddedPostgres("agent governance boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-governance-boundary-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Governance ${randomUUID()}`, issuePrefix: `G${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning();
    return company!;
  }

  async function createAgent(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role: "ceo",
        permissions: { canCreateAgents: true },
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    return agent!;
  }

  describe.each(AGENT_IDENTITIES)("with the %s identity", (source) => {
    it.each(GOVERNANCE_ACTIONS)("denies %s on itself and on a peer, even with a direct grant", async (action) => {
      const company = await createCompany();
      const actorAgent = await createAgent(company.id);
      const peer = await createAgent(company.id);
      await db.insert(principalPermissionGrants).values({
        companyId: company.id,
        principalType: "agent",
        principalId: actorAgent.id,
        permissionKey: "agents:configure",
        scope: null,
      });

      for (const targetId of [actorAgent.id, peer.id]) {
        await expect(authorizationService(db).decide({
          actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, runId: randomUUID(), source },
          action,
          resource: { type: "agent", companyId: company.id, agentId: targetId },
        })).resolves.toMatchObject({ allowed: false, reason: "deny_board_only_agent_governance" });
      }
    });

    it("cannot reach the protected change path with a change-grant scope", async () => {
      const company = await createCompany();
      const actorAgent = await createAgent(company.id);

      await expect(authorizationService(db).decide({
        actor: { type: "agent", agentId: actorAgent.id, companyId: company.id, source },
        action: "agent_config:update",
        resource: { type: "agent", companyId: company.id, agentId: actorAgent.id },
        scope: { requiresChangeGrant: true, consentedChange: true },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_board_only_agent_governance" });
    });
  });

  it("still allows a board actor to change agent configuration", async () => {
    const company = await createCompany();
    const target = await createAgent(company.id);

    await expect(authorizationService(db).decide({
      actor: { type: "board", userId: "local-board", source: "local_implicit" },
      action: "agent_config:update",
      resource: { type: "agent", companyId: company.id, agentId: target.id },
    })).resolves.toMatchObject({ allowed: true });
  });

  it("gives a newly hired agent no permission grants", async () => {
    const company = await createCompany();
    const [created] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Hire ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();

    await initializeAgentHire(db, created!);

    await expect(
      db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, created!.id)),
    ).resolves.toEqual([]);
  });
});

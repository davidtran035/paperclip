import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * One row per caller-supplied wake operation. The unique index is the admission decision, so
 * concurrent and retried requests for the same operation cannot start a second run.
 */
export const agentWakeAdmissions = pgTable(
  "agent_wake_admissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Task id, or empty for a wake without a task. */
    issueScope: text("issue_scope").notNull(),
    operationKey: text("operation_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operationUq: uniqueIndex("agent_wake_admissions_operation_uq").on(
      table.companyId,
      table.agentId,
      table.issueScope,
      table.operationKey,
    ),
  }),
);

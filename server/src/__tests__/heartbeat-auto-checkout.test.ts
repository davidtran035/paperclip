import { describe, expect, it } from "vitest";
import {
  shouldAutoCheckoutIssueForWake,
} from "../services/heartbeat.ts";

describe("shouldAutoCheckoutIssueForWake", () => {
  it.each([
    { issueAssigneeAgentId: "another-agent" }, { isDependencyReady: false },
    { issueStatus: "done" }, { issueStatus: "cancelled" }, { issueStatus: "in_review" },
    { contextSnapshot: {} }, { contextSnapshot: { wakeReason: "issue_comment_mentioned" } },
    { contextSnapshot: { wakeReason: "source_scoped_recovery_action" } },
    { contextSnapshot: { wakeReason: "execution_resumed" } },
  ])("does not grant an automatic checkout outside the eligible assigned wake: %j", override => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" }, issueStatus: "todo",
      issueAssigneeAgentId: "agent-1", isDependencyReady: true, agentId: "agent-1", ...override,
    })).toBe(false);
  });

  it.each(["manual_review", "issue_commented", "issue_status_changed", "issue_unblock_requested"])(
    "does not restart a blocked task for the %s wake",
    (wakeReason) => {
      expect(shouldAutoCheckoutIssueForWake({
        contextSnapshot: { wakeReason }, issueStatus: "blocked",
        issueAssigneeAgentId: "agent-1", isDependencyReady: true, agentId: "agent-1",
      })).toBe(false);
    },
  );

  it.each(["issue_blockers_resolved", "issue_children_completed", "approval_approved"])(
    "resumes a blocked task for the server-issued %s wake",
    (wakeReason) => {
      expect(shouldAutoCheckoutIssueForWake({
        contextSnapshot: { wakeReason }, issueStatus: "blocked",
        issueAssigneeAgentId: "agent-1", isDependencyReady: true, agentId: "agent-1",
      })).toBe(true);
    },
  );

  it("auto-checks out an assigned todo issue for an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(true);
  });

  it("leaves an idle review issue in review without an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: {},
      issueStatus: "in_review",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(false);
  });

  it("does not auto-checkout pending execution-review state even if the row status is todo", () => {
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const coderAgentId = "22222222-2222-4222-8222-222222222222";
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_recovery_action_restored" },
      issueStatus: "todo",
      issueAssigneeAgentId: reviewerAgentId,
      issueExecutionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      isDependencyReady: true,
      agentId: reviewerAgentId,
    })).toBe(false);
  });
});

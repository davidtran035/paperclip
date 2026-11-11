import { describe, expect, it } from "vitest";
import {
  isTaskBridgeCancelOnlyUpdate,
  parseTaskBridgeRunlessWrites,
  taskBridgeRunlessWriteAllowed,
} from "../services/task-bridge-runless-writes.ts";

const keyId = "0f8248ae-0000-4000-8000-00000000b41d";
const otherKey = "0f8248ae-0000-4000-8000-00000000b41e";

function parse(raw: string | undefined) {
  const warnings: string[] = [];
  return { grants: parseTaskBridgeRunlessWrites(raw, (m) => warnings.push(m)), warnings };
}

describe("task bridge runless write grants", () => {
  it("reads a grant naming a key and comment or cancel", () => {
    const { grants, warnings } = parse(JSON.stringify({ [keyId]: ["comment", "cancel"] }));
    expect([...(grants.get(keyId) ?? [])]).toEqual(["comment", "cancel"]);
    expect(warnings).toEqual([]);
  });

  it("grants nothing when unset", () => {
    expect(parse(undefined).grants.size).toBe(0);
    expect(parse("").grants.size).toBe(0);
  });

  it.each([
    "not json",
    "[]",
    "null",
    JSON.stringify({ "not-a-key": ["comment"] }),
    JSON.stringify({ [keyId]: ["comment", "done"] }),
    JSON.stringify({ [keyId]: "comment" }),
    JSON.stringify({ [keyId]: ["comment"], other: ["cancel"] }),
  ])("grants nothing for a malformed value %s", (raw) => {
    const { grants, warnings } = parse(raw);
    expect(grants.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("task bridge runless write decision", () => {
  const grants = parse(JSON.stringify({ [keyId]: ["comment", "cancel"], [otherKey]: ["comment"] })).grants;
  const own = { originKind: "task_bridge", originId: keyId };
  const base = { grants, isTaskBridgeKey: true, keyId, runId: null, issue: own, write: "comment" as const };

  it("allows a granted write on an issue the key created", () => {
    expect(taskBridgeRunlessWriteAllowed(base)).toBe(true);
    expect(taskBridgeRunlessWriteAllowed({ ...base, write: "cancel" })).toBe(true);
  });

  it("refuses a write the key was not granted", () => {
    expect(taskBridgeRunlessWriteAllowed({ ...base, keyId: otherKey, issue: { originKind: "task_bridge", originId: otherKey }, write: "cancel" })).toBe(false);
  });

  it("refuses an issue another key or a person created", () => {
    expect(taskBridgeRunlessWriteAllowed({ ...base, issue: { originKind: "task_bridge", originId: otherKey } })).toBe(false);
    expect(taskBridgeRunlessWriteAllowed({ ...base, issue: { originKind: "manual", originId: keyId } })).toBe(false);
    expect(taskBridgeRunlessWriteAllowed({ ...base, issue: {} })).toBe(false);
  });

  it("leaves requests that carry a run, and other keys, to the normal checks", () => {
    expect(taskBridgeRunlessWriteAllowed({ ...base, runId: "run-1" })).toBe(false);
    expect(taskBridgeRunlessWriteAllowed({ ...base, isTaskBridgeKey: false })).toBe(false);
    expect(taskBridgeRunlessWriteAllowed({ ...base, keyId: null })).toBe(false);
  });

  it("treats only a status change to cancelled as a cancel", () => {
    expect(isTaskBridgeCancelOnlyUpdate({ updateFields: { status: "cancelled" }, hasOtherChanges: false })).toBe(true);
    expect(isTaskBridgeCancelOnlyUpdate({ updateFields: { status: "done" }, hasOtherChanges: false })).toBe(false);
    expect(isTaskBridgeCancelOnlyUpdate({ updateFields: { status: "cancelled", title: "x" }, hasOtherChanges: false })).toBe(false);
    expect(isTaskBridgeCancelOnlyUpdate({ updateFields: { status: "cancelled" }, hasOtherChanges: true })).toBe(false);
    expect(isTaskBridgeCancelOnlyUpdate({ updateFields: {}, hasOtherChanges: false })).toBe(false);
  });
});

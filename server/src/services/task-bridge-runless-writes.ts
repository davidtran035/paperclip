import { isUuidLike } from "@paperclipai/shared";

// A task bridge key has no heartbeat run, so the cross-issue run cap refuses every comment and update it makes,
// although authorization already lets it comment on and mutate the issues it created. An instance may name keys in
// PAPERCLIP_TASK_BRIDGE_RUNLESS_WRITES, as {"<key id>": ["comment", "cancel"]}. A named key may make exactly the writes
// listed for it without a run, and only on an issue it created: a comment, or moving the issue to cancelled.
//
// The grant is server configuration rather than a key scope field. A scope Paperclip cannot parse is read as a
// standard key, so a scope flag would widen the key if this change were rolled back; an entry an unpatched server
// never reads leaves the key refused.

export type TaskBridgeRunlessWrite = "comment" | "cancel";
export type TaskBridgeRunlessWriteGrants = ReadonlyMap<string, ReadonlySet<TaskBridgeRunlessWrite>>;

const WRITE_KINDS = new Set<string>(["comment", "cancel"]);

/** Any malformed value grants nothing; a partly valid value is not partly applied. */
export function parseTaskBridgeRunlessWrites(
  raw: string | undefined,
  warn: (message: string) => void,
): TaskBridgeRunlessWriteGrants {
  const grants = new Map<string, Set<TaskBridgeRunlessWrite>>();
  if (!raw) return grants;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    for (const [keyId, writes] of Object.entries(value)) {
      if (!isUuidLike(keyId) || !Array.isArray(writes) || writes.some((write) => !WRITE_KINDS.has(write))) {
        throw new Error("bad entry");
      }
      grants.set(keyId, new Set(writes as TaskBridgeRunlessWrite[]));
    }
  } catch {
    warn("PAPERCLIP_TASK_BRIDGE_RUNLESS_WRITES is invalid; no task bridge key may write without a run");
    return new Map();
  }
  return grants;
}

export function taskBridgeRunlessWriteAllowed(input: {
  grants: TaskBridgeRunlessWriteGrants;
  isTaskBridgeKey: boolean;
  keyId?: string | null;
  runId?: string | null;
  issue: { originKind?: string | null; originId?: string | null };
  write: TaskBridgeRunlessWrite;
}) {
  // A request that names a run keeps every normal run check.
  if (!input.isTaskBridgeKey || input.runId || !input.keyId) return false;
  if (input.issue.originKind !== "task_bridge" || input.issue.originId !== input.keyId) return false;
  return input.grants.get(input.keyId)?.has(input.write) === true;
}

/** The only update a granted key may make without a run: the status, to cancelled, with nothing else. */
export function isTaskBridgeCancelOnlyUpdate(input: {
  updateFields: Record<string, unknown>;
  hasOtherChanges: boolean;
}) {
  return !input.hasOtherChanges &&
    Object.keys(input.updateFields).length === 1 &&
    input.updateFields.status === "cancelled";
}

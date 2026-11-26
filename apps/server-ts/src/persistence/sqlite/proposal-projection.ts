import type {
  TaskProposalFields,
  TaskProposalRetirement,
  TaskProposalSignal,
  TaskProposalState
} from "@arden-hq/protocol/proposals"
import { Schema } from "effect"
import type { ProposalRow } from "./task-proposals.js"

export const SignalSnapshotSchema = Schema.Struct({
  source: Schema.NonEmptyString,
  title: Schema.String,
  from: Schema.NullOr(Schema.String)
})

const NO_RETIREMENT: TaskProposalRetirement = { reason: "", evidence: [] }

export const signalOf = (
  snapshot: typeof SignalSnapshotSchema.Type | undefined
): TaskProposalSignal =>
  snapshot === undefined
    ? { kind: "unsignalled" }
    : {
        kind: "signal",
        source: snapshot.source,
        title: snapshot.title,
        from: snapshot.from === null ? { kind: "unnamed" } : { kind: "named", name: snapshot.from }
      }

const settled =
  (status: "rejected" | "expired") =>
  (row: ProposalRow): TaskProposalState | undefined =>
    row.settled_at === null ? undefined : { status, settled_at: row.settled_at }

const STATE_OF: {
  readonly [Status in ProposalRow["status"]]: (
    row: ProposalRow,
    retirement: TaskProposalRetirement | undefined
  ) => TaskProposalState | undefined
} = {
  held: () => ({ status: "held" }),
  offered: (row) => ({
    status: "offered",
    put_off:
      row.put_off_until === null
        ? { kind: "in_view" }
        : { kind: "put_off", until: row.put_off_until }
  }),
  accepted: (row) =>
    row.settled_at === null
      ? undefined
      : {
          status: "accepted",
          settled_at: row.settled_at,
          task: row.item_id === null ? { kind: "gone" } : { kind: "kept", item_id: row.item_id }
        },
  rejected: settled("rejected"),
  expired: settled("expired"),
  retired: (row, retirement) =>
    row.settled_at === null
      ? undefined
      : {
          status: "retired",
          settled_at: row.settled_at,
          retirement: retirement ?? NO_RETIREMENT
        }
}

export const proposalStateOf = (
  row: ProposalRow,
  retirement: TaskProposalRetirement | undefined
): TaskProposalState | undefined => STATE_OF[row.status](row, retirement)

const placementOf = (row: ProposalRow): TaskProposalFields["placement"] | undefined => {
  if (row.space_id !== null) return { kind: "space", space_id: row.space_id }
  if (row.chat_session_id !== null) return { kind: "chat", session_id: row.chat_session_id }
  return undefined
}

export const proposalFieldsOf = (
  row: ProposalRow,
  parts: Pick<TaskProposalFields, "capture" | "sources" | "signal">
): TaskProposalFields | undefined => {
  const placement = placementOf(row)
  if (placement === undefined) return undefined
  return {
    proposal_id: row.proposal_id,
    placement,
    stable_key: row.stable_key,
    text: row.text,
    body: row.body === null ? { kind: "plain" } : { kind: "detailed", text: row.body },
    owner: row.owner,
    ...parts,
    origin:
      row.source_run_id === null ||
      row.source_session_id === null ||
      row.source_turn_id === null ||
      row.source_tool_call_id === null
        ? { kind: "router" }
        : {
            kind: "run",
            run_id: row.source_run_id,
            session_id: row.source_session_id,
            turn_id: row.source_turn_id,
            tool_call_id: row.source_tool_call_id
          },
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

import type { RetirementSourceRecord } from "../persistence/work/task-record.js"
import { KeyedTaskDraftSchema } from "../persistence/work/task-input.js"
import { quoted } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { ChatActionRetirementSourceSchema } from "@arden-hq/protocol/effect/proposals"
import {
  TASK_PROPOSAL_ORIGIN,
  TASK_PROPOSAL_RETIREMENT_EVIDENCE,
  TASK_PROPOSAL_RETIREMENT_SOURCE,
  TASK_PROPOSAL_STATUS,
  TASK_PROPOSAL_TASK
} from "@arden-hq/protocol/proposals"
import { SPACE_KIND } from "@arden-hq/protocol/spaces"
import { TASK_STATUS } from "@arden-hq/protocol/spaces/work"
import { WIKI_PAGE_LIFECYCLE } from "@arden-hq/protocol/wiki"
import { Effect, Schema, Struct } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { WorkStore } from "../persistence/work/store.js"
import { TaskProposalStore } from "../persistence/proposals/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { Wiki } from "../wiki/service.js"
import type { Snapshot } from "../wiki/snapshot.js"
import {
  TASK_BODY_DESCRIPTION,
  TASK_SPACE_RULE,
  TASK_OWNER_DESCRIPTION,
  TASK_TEXT_DESCRIPTION
} from "./task-wording.js"
import { loadSnapshot } from "./wiki-access.js"
import { observedKey, type ServerRunContext } from "./run-context.js"
import { recordApplied } from "../execution/tool-effect.js"
import { toolFailure, toolRefusal } from "./tool-failure.js"

interface Services {
  readonly work: WorkStore["Service"]
  readonly proposals: TaskProposalStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly spaces: SpaceStore["Service"]
  readonly wiki: Wiki["Service"]
}

const evidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat").annotate({ description: "Evidence from a physical Chat turn." }),
    session_id: Schema.NonEmptyString.annotate({ description: "Exact source Chat session id." }),
    turn_id: Schema.NonEmptyString.annotate({
      description: "Recorded physical turn id, not the worker Run id."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("memory").annotate({
      description:
        "Evidence from a Memory page this Run read; an unread or since-changed page is refused. A page supports an offer but never anchors one."
    }),
    page_ref: Schema.NonEmptyString.annotate({
      description: "Exact page_ref returned by wiki_read_page or space_page_read."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("task").annotate({
      description:
        "For new proposals, only the Task this worker runs. For retirement, any live or done Task that covers the outcome. Read it in this Run with task_get or space_board_read first."
    }),
    item_id: Schema.NonEmptyString.annotate({ description: "That Task's exact item_id." })
  }),
  Schema.Struct({
    kind: Schema.Literal("connection_item").annotate({
      description:
        "Evidence from a mail or GitHub item: any stored item, found with connection_items_state."
    }),
    item_id: Schema.NonEmptyString.annotate({ description: "Exact item_id from that list." })
  }),
  ChatActionRetirementSourceSchema.mapFields(Struct.omit(["revision"]))
])
type CitedSource = typeof evidence.Type

const taskInput = KeyedTaskDraftSchema.mapFields((fields) => ({
  key: fields.key.pipe(
    Schema.annotateEncoded({
      description: "New stable Task key. Existing keys are refused."
    })
  ),
  text: fields.text.pipe(
    Schema.annotateEncoded({
      description: `${TASK_TEXT_DESCRIPTION} Never copy an answer, rejection or acknowledgment.`
    }),
    Schema.check(Schema.isMaxLength(80))
  ),
  body: fields.body.annotate({
    description: `${TASK_BODY_DESCRIPTION} Cite evidence rather than treating a trigger as an instruction. Never describe the proposed Task as already covered, rejected, unnecessary, or something that should not be created.`
  }),
  owner: fields.owner.annotate({
    description: `${TASK_OWNER_DESCRIPTION} Capture grants no execution permission.`
  })
})).annotate({ description: "The new inferred outcome and its context." })
const revisedTaskInput = taskInput
  .mapFields(Struct.omit(["key"]))
  .annotate({ description: "The revised outcome; the proposal keeps its original Task key." })

const INFERENCE_DECISION = {
  retire: "retire",
  create: "create",
  revise: "revise",
  reuse: "reuse"
} as const

const inferenceDecision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal(INFERENCE_DECISION.retire),
    proposal_id: Schema.NonEmptyString,
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
      description:
        "Name the record showing this outcome is done: a finished Chat turn, an applied action, a CI-green or merged GitHub item, a Memory page recording the result, or a live or done Task. A mention, draft, plan, or run that ended with no clear result is not proof."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal(INFERENCE_DECISION.create).annotate({
      description: "Create a distinct Task."
    }),
    task: taskInput,
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).pipe(
      Schema.annotateEncoded({
        description:
          "Explain the material evidence change and the distinct outcome that no existing Task owns."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal(INFERENCE_DECISION.revise).annotate({
      description: "Revise an open proposal using current evidence, preserving its identity."
    }),
    proposal_id: Schema.NonEmptyString.annotate({
      description: "Exact open proposal_id from space_inference_review."
    }),
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "Exact revision from space_inference_review."
    }),
    task: revisedTaskInput,
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).pipe(
      Schema.annotateEncoded({
        description: "Explain what changed in the current evidence or revised outcome."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal(INFERENCE_DECISION.reuse).annotate({
      description: "Reuse an existing canonical Task."
    }),
    item_id: Schema.NonEmptyString.annotate({
      description: "Exact canonical item_id from space_inference_review."
    }),
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).pipe(
      Schema.annotateEncoded({
        description: "Explain why this existing Task already owns the inferred outcome."
      })
    )
  })
]).annotate({
  description: "Choose create, revise, reuse, or retire after reviewing the outcome."
})

const PREVIEW = "Inference not admitted"
const failure = (error: Parameters<typeof toolFailure>[0]) => toolFailure(error, PREVIEW)
const refusal = (message: string) => toolRefusal(message, PREVIEW)
const runSpace = async (services: Services, sessionId: string, signal: AbortSignal) => {
  const header = await Effect.runPromise(services.sessions.loadHistoryHeader(sessionId), { signal })
  return header?.spaceId ?? undefined
}

const reviewedSpace = async (
  services: Services,
  spaceId: string | undefined,
  signal: AbortSignal
): Promise<string> => {
  if (spaceId !== undefined) return spaceId
  const spaces = await Effect.runPromise(
    services.spaces.list().pipe(Effect.mapError((cause) => failure(cause))),
    { signal }
  )
  const main = spaces.find((space) => space.kind === SPACE_KIND.main)
  if (main === undefined) throw failure({ reason: "storage", message: "The Main Space is missing" })
  return main.space_id
}

const makeTaskInferenceTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_inference_review",
    summary: "Reviews work Arden noticed in your chats.",
    discovery: { group: "task_inference" },
    description:
      "Read Tasks, open proposals, Chat activity and the offers the user rejected or left to expire before inferring work. Never duplicate an open proposal or completed Chat outcome. Compare semantic overlap and reuse existing Tasks. A fact, preference or one-off question is not a Task. A recent trigger is not fresh evidence: inspect the actual changed Chat turn or Memory page. task_propose is checked against this Run's latest review: call this again after a proposal succeeds or is refused because the Space changed.",
    parameters: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Never)),
    metadata: {
      effect: "none",
      display_name: "Review inferred work",
      kind: "tool",
      action: "read",
      source: "_spaces",
      changes_state: false,
      destructive: false,
      concurrency_group: null,
      approval_preview: "Review Task evidence and rejected inferences."
    },
    execute: async (_input, ctx) => {
      const spaceId = await runSpace(services, ctx.run.sessionId, ctx.signal)
      const target = await reviewedSpace(services, spaceId, ctx.signal)
      const { snapshot, ...review } = await Effect.runPromise(
        services.work.inferenceReview(target).pipe(Effect.mapError((cause) => failure(cause))),
        { signal: ctx.signal }
      )
      ctx.run.observations.observe(observedKey.inferenceReview(spaceId), snapshot)
      return {
        result:
          spaceId === undefined
            ? `This run works in no Space, so a proposal goes to the Main Space. Its work: ${JSON.stringify(review)}`
            : JSON.stringify(review),
        preview: `${review.tasks.length} Tasks, ${review.rejections.length} rejected inferences`,
        data: review
      }
    }
  }),
  defineServerTool({
    name: "task_propose",
    summary: "Proposes a Task for you to start.",
    discovery: { group: "task_inference" },
    description: `Propose one Task for the user to start, on this run's Space while it suggests tasks: from its Space review, a worker of one of its Tasks, or an Automation working in it. Background runs never start Tasks; the user's Start does. Read space_inference_review first. A Space review chooses revise with the exact proposal_id and expected_revision when an open proposal still names the same outcome but needs current wording or evidence; cite newly observed sources, and preserve the proposal identity. Revise does not start a Task. Choose retire with the exact proposal_id and expected_revision when a settled record shows an open proposal's outcome is done; retirement is not a user rejection. Retirement may cite any record Arden holds, on any Space or none: a finished Chat turn (find it with session_search_transcripts, scope all_spaces), an exact applied action (session_read with view actions, copy its chat_action source), a Memory page read in this Run, a live or done Task, or a stored mail or GitHub item (connection_items_state, connection_item_read). Retire only on a record showing the outcome is done; a mention, draft, plan, or run that ended with no clear result is not proof. Unsure: keep the proposal. Do not duplicate work already being performed in Chat or already completed there. Choose reuse with the canonical Task item_id whenever a live or done Task already owns the outcome; a cancelled Task owns nothing, and a Task that does not own the outcome is never a reuse target; it returns the exact Task deep link and performs no mutation. Choose create only for a distinct outcome anchored by a finished Chat turn in the current Space, a stored item, or the Task this worker works on; a Memory page may support it but never anchors it; an item whose thread is already an offer, a Task or a skipped offer is refused, and so is any new proposal while the Space has three open ones. Linked or foreign evidence may support existing work but cannot create work here. A run that works in no Space (an Automation, or a worker of a Task without one) proposes to the Main Space instead: it creates only, citing a turn of its own chat, its own Task or a stored item; a Memory page it read may support it. ${
      TASK_SPACE_RULE
    } Never create a consolidation, cleanup, or replacement Task for overlap. The user's own chat starts Tasks with task_start instead. Cite observed evidence that fully defines the outcome. A reply that only answers, rejects or acknowledges prior conversation is not an outcome. Ambiguity or stale evidence should remain a suggestion. When nothing qualifies, do not call this tool. Admission rechecks ownership, that the Space is still as this Run's space_inference_review showed it, policy and rejected evidence; a refused call changes nothing.`,
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        sources: Schema.NonEmptyArray(evidence).annotate({
          description:
            "Required for every decision. The evidence for it: observed Chat turns, Memory pages read in this Run, connection items, or this worker's own Task. Proposing needs at least one current-Space Chat turn, stored item, or this worker's own Task; Memory pages only support it. Retiring also accepts exact chat_action sources from session_read with view actions, and its Chat turns, items and Tasks need not belong to this Space."
        }),
        decision: inferenceDecision
      })
    ),
    metadata: {
      effect: "run_record",
      scopes: ["worker", "observer"],
      display_name: "Propose Task",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Propose a Task, with its evidence, for you to start or reject."
    },
    execute: async (input, ctx, effects) => {
      const spaceId = await runSpace(services, ctx.run.sessionId, ctx.signal)
      const reviewed = ctx.run.observations.observed(observedKey.inferenceReview(spaceId))
      if (reviewed === undefined)
        throw failure({
          reason: "conflict",
          message:
            "Call space_inference_review first; a proposal is checked against what that review showed"
        })
      if (
        input.decision.kind !== INFERENCE_DECISION.retire &&
        input.sources.some((source) => source.kind === TASK_PROPOSAL_RETIREMENT_SOURCE.chat_action)
      )
        throw refusal("Action evidence is for proposal retirement only")
      const memoryCited = input.sources.some(
        (source) => source.kind === TASK_PROPOSAL_RETIREMENT_EVIDENCE.memory
      )
      const snapshot = memoryCited ? await loadSnapshot(services.wiki, ctx.signal) : undefined
      const sources = input.sources.map((source) => observedSource(ctx.run, source, snapshot))
      const ordinarySources = sources.filter(
        (source) => source.kind !== TASK_PROPOSAL_RETIREMENT_SOURCE.chat_action
      )
      if (input.decision.kind === INFERENCE_DECISION.retire) {
        if (spaceId === undefined) throw refusal("Retirement requires a Space review")
        const proposal = await recordApplied(
          effects,
          Effect.runPromise(
            services.proposals
              .retire({
                spaceId,
                runId: ctx.run.runId,
                toolCallId: ctx.toolCallId,
                proposalId: input.decision.proposal_id,
                expectedRevision: input.decision.expected_revision,
                snapshot: reviewed,
                reason: input.decision.reason,
                sources
              })
              .pipe(Effect.mapError((cause) => failure(cause))),
            { signal: ctx.signal }
          )
        )
        return {
          result: `Retired ${quoted(proposal.text)}. Include ${proposal.proposal_id} in space_review_finish with kind reconciled.`,
          preview: proposal.text,
          data: { decision: "retire", proposal }
        }
      }
      if (input.decision.kind === INFERENCE_DECISION.reuse) {
        const decision = input.decision
        const target = await reviewedSpace(services, spaceId, ctx.signal)
        const review = await Effect.runPromise(
          services.work.inferenceReview(target).pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
        if (review.snapshot !== reviewed)
          throw failure({
            reason: "conflict",
            message: "Space work changed since review; inspect the new Tasks before deciding again"
          })
        const task = review.tasks.find((candidate) => candidate.item_id === decision.item_id)
        if (task === undefined)
          throw refusal("The selected Task is not on this Space; review the Space again")
        if (task.status === TASK_STATUS.cancelled)
          throw new ToolExecutionError(
            "That Task is cancelled, so it owns no new work. Create a Task only for a distinct outcome the evidence fully defines; otherwise infer nothing. This refusal changed nothing, so the review can still finish as no change.",
            { preview: "Task is closed", retryable: false }
          )
        const taskUrl = `arden:task/${encodeURIComponent(task.item_id)}`
        effects.unchanged()
        return {
          result: `Reuse ${namedLink(task.text, taskUrl)}. Do not create another Task.`,
          preview: task.text,
          data: { decision: "reuse", task, task_url: taskUrl, reason: decision.reason }
        }
      }
      if (input.decision.kind === INFERENCE_DECISION.revise) {
        if (spaceId === undefined) throw refusal("Proposal revision requires a Space review")
        const decision = input.decision
        const proposal = await recordApplied(
          effects,
          Effect.runPromise(
            services.proposals
              .revise({
                spaceId,
                proposalId: decision.proposal_id,
                expectedRevision: decision.expected_revision,
                runId: ctx.run.runId,
                sessionId: ctx.run.sessionId,
                toolCallId: ctx.toolCallId,
                input: decision.task,
                capture: { basis: "inferred", reason: decision.reason },
                sources: ordinarySources,
                inferenceSnapshot: reviewed
              })
              .pipe(Effect.mapError((cause) => failure(cause))),
            { signal: ctx.signal }
          )
        )
        return {
          result: `Revised ${quoted(proposal.text)}. The user must accept it before a Task exists. proposal_id: ${proposal.proposal_id}`,
          preview: proposal.text,
          data: { decision: "propose", proposal, task_url: null }
        }
      }
      const proposal = await recordApplied(
        effects,
        Effect.runPromise(
          services.proposals
            .propose({
              spaceId,
              runId: ctx.run.runId,
              sessionId: ctx.run.sessionId,
              toolCallId: ctx.toolCallId,
              inferenceSnapshot: reviewed,
              input: input.decision.task,
              capture: { basis: "inferred", reason: input.decision.reason },
              sources: ordinarySources
            })
            .pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
      )
      let taskUrl: string | null = null
      const authored =
        proposal.origin.kind === TASK_PROPOSAL_ORIGIN.run &&
        proposal.origin.run_id === ctx.run.runId &&
        proposal.origin.tool_call_id === ctx.toolCallId
      let result: string
      switch (proposal.status) {
        case TASK_PROPOSAL_STATUS.held:
        case TASK_PROPOSAL_STATUS.offered:
          result = authored
            ? `Proposed ${quoted(proposal.text)}. The user must accept it before a Task exists. proposal_id: ${proposal.proposal_id} (a Space review passes it verbatim to space_review_finish).`
            : `Already proposed: ${quoted(proposal.text)}. This call changed nothing; do not count it as a new proposal.`
          break
        case TASK_PROPOSAL_STATUS.retired:
          result = `The proposal ${quoted(proposal.text)} was retired after its outcome was reviewed.`
          break
        case TASK_PROPOSAL_STATUS.rejected:
          result = `You rejected ${quoted(proposal.text)}; it is not offered again. This call changed nothing.`
          break
        case TASK_PROPOSAL_STATUS.expired:
          result = `${quoted(proposal.text)} expired unanswered; it is not offered again. This call changed nothing.`
          break
        case TASK_PROPOSAL_STATUS.accepted:
          if (proposal.task.kind === TASK_PROPOSAL_TASK.gone)
            throw refusal("Accepted Task proposal is missing its Task")
          taskUrl = `arden:task/${encodeURIComponent(proposal.task.item_id)}`
          result = `This proposal already resolved to ${namedLink(proposal.text, taskUrl)}.`
          break
      }
      return {
        result,
        preview: proposal.text,
        data: {
          decision: authored ? "propose" : "reuse",
          proposal,
          task_url: taskUrl
        }
      }
    }
  })
]

const unread = (message: string): ToolExecutionError => failure({ reason: "conflict", message })

const observedSource = (
  run: ServerRunContext,
  source: CitedSource,
  snapshot: Snapshot | undefined
): RetirementSourceRecord => {
  switch (source.kind) {
    case TASK_PROPOSAL_RETIREMENT_EVIDENCE.chat:
      return { ...source, revision: source.turn_id }
    case TASK_PROPOSAL_RETIREMENT_EVIDENCE.connection_item:
      return { ...source, revision: source.item_id }
    case TASK_PROPOSAL_RETIREMENT_EVIDENCE.memory: {
      const page = snapshot?.pages.find(
        (record) =>
          record.page.pageId === source.page_ref &&
          record.page.lifecycle === WIKI_PAGE_LIFECYCLE.active
      )
      const revision = run.observations.observed(source.page_ref)
      if (page === undefined || revision !== page.resource.versionId)
        throw unread("Read the current Memory page in this Run first, then cite its exact page_ref")
      return { ...source, page_ref: page.page.pageId, revision }
    }
    case TASK_PROPOSAL_RETIREMENT_EVIDENCE.task: {
      const revision = run.observations.observed(observedKey.task(source.item_id))
      if (revision === undefined)
        throw unread(
          "Read the Task in this Run with task_get or space_board_read first, then cite its item_id"
        )
      return { ...source, revision }
    }
    case TASK_PROPOSAL_RETIREMENT_SOURCE.chat_action: {
      const revision = run.observations.observed(
        observedKey.chatAction(source.run_id, source.tool_call_id)
      )
      if (revision === undefined)
        throw unread(
          "Read the action in this Run with session_read (view actions) first, then copy its chat_action source"
        )
      return { ...source, revision }
    }
  }
}

const namedLink = (label: string, url: string): string =>
  `[${label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](${url})`

export const taskInferenceTools = Effect.gen(function* () {
  return makeTaskInferenceTools({
    work: yield* WorkStore,
    proposals: yield* TaskProposalStore,
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore,
    wiki: yield* Wiki
  })
})

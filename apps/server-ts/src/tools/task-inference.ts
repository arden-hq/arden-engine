import { quoted } from "@arden-hq/std/count"
import { ToolExecutionError } from "@arden-hq/loop"
import { ChatActionRetirementSourceSchema } from "@arden-hq/protocol/effect/proposals"
import type { SpaceTaskSource } from "@arden-hq/protocol/spaces/work"
import { CreateSpaceTaskInputSchema } from "@arden-hq/protocol/effect/spaces/work"
import { Effect, Schema, Struct } from "effect"
import { defineServerTool, type ServerTool } from "./define.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { WorkStore } from "../persistence/work/store.js"
import { TaskProposalStore } from "../persistence/proposals/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { wikiPathWithinSpaceBoundary } from "../wiki/authority.js"
import { Wiki } from "../wiki/service.js"
import type { Snapshot } from "../wiki/snapshot.js"
import {
  TASK_BODY_DESCRIPTION,
  TASK_SPACE_RULE,
  TASK_OWNER_DESCRIPTION,
  TASK_TEXT_DESCRIPTION
} from "./task-wording.js"
import { loadSnapshot } from "./wiki.js"
import { recordApplied } from "../execution/tool-effect.js"
import { toolFailure, toolRefusal } from "./tool-failure.js"

interface Services {
  readonly spaces: SpaceStore["Service"]
  readonly work: WorkStore["Service"]
  readonly proposals: TaskProposalStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly wiki: Wiki["Service"]
}

const evidence = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("chat").annotate({ description: "Evidence from a physical Chat turn." }),
    session_id: Schema.NonEmptyString.annotate({ description: "Exact source Chat session id." }),
    turn_id: Schema.NonEmptyString.annotate({
      description: "Recorded physical turn id, not the worker Run id."
    }),
    revision: Schema.NonEmptyString.annotate({ description: "The exact turn id read as evidence." })
  }),
  Schema.Struct({
    kind: Schema.Literal("memory").annotate({
      description: "Evidence from an observed Memory page."
    }),
    page_ref: Schema.NonEmptyString.annotate({
      description: "Exact page_ref returned by wiki_read_page or space_page_read."
    }),
    revision: Schema.NonEmptyString.annotate({
      description:
        "Exact revision returned by the page read in this Run; stale or unread versions are refused."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("task").annotate({
      description:
        "For new proposals, only the Task this worker runs. For retirement, any live or done Task that covers the outcome."
    }),
    item_id: Schema.NonEmptyString.annotate({ description: "That Task's exact item_id." }),
    revision: Schema.NonEmptyString.annotate({
      description: "Exact history_revision from task_get or space_board_read."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("connection_item").annotate({
      description:
        "Evidence from a mail or GitHub item. To create, one routed to this Space, listed under Routed connection items. To retire, any stored item, found with connection_items_state."
    }),
    item_id: Schema.NonEmptyString.annotate({ description: "Exact item_id from that list." }),
    revision: Schema.NonEmptyString.annotate({ description: "The same item_id again." })
  })
])
const taskInput = CreateSpaceTaskInputSchema.mapFields((fields) => ({
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

const inferenceDecision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("retire"),
    proposal_id: Schema.NonEmptyString,
    expected_revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
      description:
        "Name the record showing this outcome is done: a finished Chat turn, an applied action, a CI-green or merged GitHub item, a Memory page recording the result, or a live or done Task. A mention, draft, plan, or run that ended with no clear result is not proof."
    })
  }),
  Schema.Struct({
    kind: Schema.Literal("create").annotate({ description: "Create a distinct Task." }),
    task: taskInput,
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).pipe(
      Schema.annotateEncoded({
        description:
          "Explain the material evidence change and the distinct outcome that no existing Task owns."
      })
    )
  }),
  Schema.Struct({
    kind: Schema.Literal("revise").annotate({
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
    kind: Schema.Literal("reuse").annotate({ description: "Reuse an existing canonical Task." }),
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

const HOME_REVIEW = "home"

const makeTaskInferenceTools = (services: Services): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "space_inference_review",
    description:
      "Read Tasks, open proposals, Chat activity and durable rejections before inferring work. Never duplicate an open proposal or completed Chat outcome. Compare semantic overlap and reuse existing Tasks. A fact, preference or one-off question is not a Task. A recent trigger is not fresh evidence: inspect the actual changed Chat turn or Memory page. Use the returned snapshot for one admission; re-read after any change.",
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
      if (spaceId === undefined)
        return {
          result: `This run works in no Space, so a proposal goes to Home, where the user picks its Space. There are no Space Tasks to reuse. Pass snapshot "${HOME_REVIEW}" to task_propose.`,
          preview: "No Space: proposals go to Home",
          data: { tasks: [], rejections: [], snapshot: HOME_REVIEW }
        }
      const review = await Effect.runPromise(
        services.work.inferenceReview(spaceId).pipe(Effect.mapError((cause) => failure(cause))),
        { signal: ctx.signal }
      )
      return {
        result: JSON.stringify(review),
        preview: `${review.tasks.length} Tasks, ${review.rejections.length} rejected inferences`,
        data: { ...review }
      }
    }
  }),
  defineServerTool({
    name: "task_propose",
    description: `Propose one Task for the user to start, on this run's Space while it suggests tasks: from its Space review, a worker of one of its Tasks, or an Automation working in it. Background runs never start Tasks; the user's Start does. Read space_inference_review first. A Space review chooses revise with the exact proposal_id and expected_revision when an open proposal still names the same outcome but needs current wording or evidence; cite newly observed sources, and preserve the proposal identity. Revise does not start a Task. Choose retire with the exact proposal_id and expected_revision when a settled record shows an open proposal's outcome is done; retirement is not a user rejection. Retirement may cite any record Arden holds, on any Space or none: a Chat's latest finished turn (find it with session_search_transcripts, scope all_spaces), an exact applied action (session_read with view actions, copy its chat_action source), a Memory page read at its current revision, a live or done Task, or a stored mail or GitHub item (connection_items_state, connection_item_read). Retire only on a record showing the outcome is done; a mention, draft, plan, or run that ended with no clear result is not proof. Unsure: keep the proposal. Do not duplicate work already being performed in Chat or already completed there. Choose reuse with the canonical Task item_id whenever a live or done Task already owns the outcome; a cancelled Task owns nothing, and a Task that does not own the outcome is never a reuse target; it returns the exact Task deep link and performs no mutation. Choose create only for a distinct outcome anchored by a Chat or Memory page owned by the current Space, a connection item routed to it, or the Task this worker works on; an item whose thread is already an offer, a Task or a skipped offer is refused, and so is any new proposal while the Space has three open ones. Linked or foreign evidence may support existing work but cannot create work here. A run that works in no Space (an Automation, or a worker of a Task without one) proposes to Home instead, where the user picks the Space: it creates only, citing a turn of its own chat, a Memory page it read, or its own Task. ${
      TASK_SPACE_RULE
    } Never create a consolidation, cleanup, or replacement Task for overlap. The user's own chat starts Tasks with task_start instead. Cite observed evidence that fully defines the outcome. A reply that only answers, rejects or acknowledges prior conversation is not an outcome. Ambiguity or stale evidence should remain a suggestion. When nothing qualifies, do not call this tool. Admission rechecks ownership, the review snapshot, policy and rejected evidence; a refused call changes nothing.`,
    parameters: Schema.toStandardSchemaV1(
      Schema.Struct({
        decision: inferenceDecision,
        snapshot: Schema.NonEmptyString.annotate({
          description:
            "Exact snapshot from the latest space_inference_review. Re-read after a conflict or successful creation."
        }),
        sources: Schema.NonEmptyArray(
          Schema.Union([evidence, ChatActionRetirementSourceSchema])
        ).annotate({
          description:
            "For retirement, exact chat_action sources returned by session_read with view actions are also accepted, and Chat turns, items and Tasks need not belong to this Space. Other decisions cannot use action sources. Observed Chat turns, current Memory page revisions, connection items or this worker's own Task supporting this outcome. Proposing requires at least one current-Space Chat, Memory page inside the current Space boundary, connection item routed to this Space, or this worker's own Task."
        })
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
      const ordinarySources = input.sources.filter((source) => source.kind !== "chat_action")
      if (input.decision.kind !== "retire" && ordinarySources.length !== input.sources.length)
        throw refusal("Action evidence is for proposal retirement only")
      if (ordinarySources.some((source) => source.kind === "memory")) {
        const snapshot = await loadSnapshot(services.wiki, ctx.signal)
        for (const source of input.sources) {
          if (source.kind !== "memory") continue
          const page = snapshot.pages.find(
            (record) => record.page.pageId === source.page_ref && record.page.lifecycle === "active"
          )
          if (
            !page ||
            source.revision !== page.resource.versionId ||
            ctx.run.observations.observed(page.page.pageId) !== source.revision
          ) {
            throw failure({
              reason: "conflict",
              message: "Read the current Memory page first and cite its exact page_ref and revision"
            })
          }
        }
        if (
          (input.decision.kind === "create" || input.decision.kind === "revise") &&
          spaceId !== undefined
        ) {
          await requireSpaceOwnershipAnchor(
            services,
            spaceId,
            ordinarySources,
            snapshot,
            ctx.signal
          )
        }
      }
      if (input.decision.kind === "retire") {
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
                snapshot: input.snapshot,
                reason: input.decision.reason,
                sources: input.sources
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
      if (input.decision.kind === "reuse") {
        if (spaceId === undefined)
          throw new ToolExecutionError(
            "This run works in no Space, so there is no Task to reuse. Propose a distinct new Task, or nothing.",
            { preview: "No Space Tasks to reuse", retryable: false }
          )
        const decision = input.decision
        const review = await Effect.runPromise(
          services.work.inferenceReview(spaceId).pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
        if (review.snapshot !== input.snapshot)
          throw failure({
            reason: "conflict",
            message: "Space work changed since review; inspect the new Tasks before deciding again"
          })
        const task = review.tasks.find((candidate) => candidate.item_id === decision.item_id)
        if (task === undefined)
          throw refusal("The selected Task is not on this Space; review the Space again")
        if (task.status === "cancelled")
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
      if (input.decision.kind === "revise") {
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
                inferenceSnapshot: input.snapshot
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
              inferenceSnapshot: input.snapshot,
              input: input.decision.task,
              capture: { basis: "inferred", reason: input.decision.reason },
              sources: ordinarySources
            })
            .pipe(Effect.mapError((cause) => failure(cause))),
          { signal: ctx.signal }
        )
      )
      const taskUrl =
        proposal.item_id === null ? null : `arden:task/${encodeURIComponent(proposal.item_id)}`
      const authored =
        proposal.source_run_id === ctx.run.runId && proposal.source_tool_call_id === ctx.toolCallId
      let result: string
      switch (proposal.status) {
        case "held":
        case "offered":
          result = authored
            ? `Proposed ${quoted(proposal.text)}. The user must accept it before a Task exists. proposal_id: ${proposal.proposal_id} (a Space review passes it verbatim to space_review_finish).`
            : `Already proposed: ${quoted(proposal.text)}. This call changed nothing; do not count it as a new proposal.`
          break
        case "retired":
          result = `The proposal ${quoted(proposal.text)} was retired after its outcome was reviewed.`
          break
        case "rejected":
          result = `The unchanged proposal ${quoted(proposal.text)} remains rejected.`
          break
        case "accepted":
          if (taskUrl === null) throw refusal("Accepted Task proposal is missing its Task")
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

const namedLink = (label: string, url: string): string =>
  `[${label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]+/g, " ")}](${url})`

const requireSpaceOwnershipAnchor = async (
  services: Services,
  spaceId: string,
  sources: ReadonlyArray<SpaceTaskSource>,
  snapshot: Snapshot,
  signal: AbortSignal
): Promise<void> => {
  if (sources.some((source) => source.kind !== "memory")) return
  const [space, spaces] = await Effect.runPromise(
    Effect.all([services.spaces.get(spaceId), services.spaces.list()]).pipe(
      Effect.mapError((cause) => failure(cause))
    ),
    { signal }
  )
  if (space === null) throw refusal("Inference requires the current Space")
  const sourcePaths = sources.flatMap((source) => {
    if (source.kind !== "memory") return []
    const record = snapshot.pages.find((page) => page.page.pageId === source.page_ref)
    return record === undefined ? [] : [record.resource.path]
  })
  const ownsSource = (pagePath: string | null): boolean =>
    pagePath !== null && sourcePaths.some((path) => wikiPathWithinSpaceBoundary(pagePath, path))
  if (ownsSource(space.page_path)) return
  const ownerNames = [
    ...new Set(
      spaces
        .filter((candidate) => candidate.space_id !== spaceId && ownsSource(candidate.page_path))
        .map((candidate) => candidate.name)
    )
  ]
  const detail =
    ownerNames.length === 0
      ? "The cited evidence is not owned by this Space."
      : `The cited evidence belongs to ${ownerNames.join(", ")}.`
  throw new ToolExecutionError(
    `New inferred Tasks need at least one Chat or Memory source owned by ${space.name}. ${detail} Do not create it here.`,
    { preview: "Task belongs elsewhere", retryable: false }
  )
}

export const taskInferenceTools = Effect.gen(function* () {
  return makeTaskInferenceTools({
    spaces: yield* SpaceStore,
    work: yield* WorkStore,
    proposals: yield* TaskProposalStore,
    sessions: yield* SessionQueries,
    wiki: yield* Wiki
  })
})

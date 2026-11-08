import { ToolExecutionError, type ToolContext } from "@arden-hq/loop"
import type { RunQuestionContent } from "@arden-hq/protocol/runs"
import { Effect, Schema } from "effect"
import {
  ContractLineInputSchema,
  EvidenceInputSchema,
  evidenceWords,
  type ContractChange,
  type ContractLine,
  type TaskContract
} from "../persistence/work/contract.js"
import { WorkStore, type WorkStoreError } from "../persistence/work/store.js"
import { SessionQueries } from "../persistence/sessions/queries.js"
import { SpaceStore } from "../persistence/spaces/store.js"
import { recordApplied } from "../execution/tool-effect.js"
import { appliedReceipt, inChatTarget } from "./call-receipt.js"
import { defineServerTool, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { readTaskAt, taskWriteMetadata, workFailure, type TaskToolServices } from "./task-tools.js"
import { toolFailure } from "./tool-failure.js"

const TaskParameters = {
  space_id: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(512)).annotate({
      description: "Exact space_id from space_list, with key. Omit for this chat's Space."
    })
  ),
  key: Schema.optionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "Exact key of the Task, from task_get or space_board_read. Omit for the Task this run works on."
    })
  )
}

const LineIdSchema = Schema.Int.check(Schema.isGreaterThan(0))

const ProposeParametersSchema = Schema.Struct({
  ...TaskParameters,
  line: Schema.optionalKey(
    ContractLineInputSchema.annotate({
      description:
        'One line in the owner\'s own terms: a rule the work keeps to ("Keep at least 3 runs going"), a done-when criterion that evidence can show ("The eval scores 0.8 or more on the held-out set"), or a decision with the options it rejected. Keep the owner\'s words; do not soften or widen them.'
    })
  ),
  replaces: Schema.optionalKey(
    LineIdSchema.annotate({
      description:
        "With line: the saved line (L<n> → n) the new line contradicts. The card shows it, and the owner's confirmation retires it. Judge this yourself against the Task contract."
    })
  ),
  remove: Schema.optionalKey(
    LineIdSchema.annotate({
      description: "Instead of line: a saved line the owner asked to drop (L<n> → n)."
    })
  )
}).check(
  Schema.makeFilter((input) => {
    if ((input.line === undefined) === (input.remove === undefined))
      return "Send exactly one of line or remove"
    if (input.replaces !== undefined && input.line === undefined) return "replaces goes with line"
    return undefined
  })
)

const MeetParametersSchema = Schema.Struct({
  ...TaskParameters,
  line_id: LineIdSchema.annotate({
    description: "The done-when criterion this evidence meets (L<n> → n)."
  }),
  evidence: EvidenceInputSchema.annotate({
    description:
      "What shows the criterion is met. The server resolves it from its own records and refuses what it cannot resolve; your description is not evidence."
  })
})

type TaskSelector = { readonly space_id?: string | undefined; readonly key?: string | undefined }

const resolveTask = async (
  services: TaskToolServices,
  ctx: ToolContext<ServerRunContext>,
  input: TaskSelector,
  scope: "this_chat" | "reach"
): Promise<{ readonly itemId: string; readonly contract: TaskContract }> => {
  const run = <A>(effect: Effect.Effect<A, WorkStoreError>) =>
    Effect.runPromise(effect.pipe(Effect.mapError(workFailure)), { signal: ctx.signal })
  if (input.key !== undefined) {
    const task = await readTaskAt(services, ctx, input.space_id, input.key)
    if (scope === "this_chat" && task.home_session_id !== ctx.run.sessionId)
      throw new ToolExecutionError(
        "Propose lines only for a Task this chat works on or started; the owner's words here are about it, not about another chat's Task.",
        { preview: "Not this chat's Task", retryable: false }
      )
    const snapshot = await run(services.work.taskContext(task.item_id))
    if (snapshot === undefined) throw notFound()
    return { itemId: snapshot.itemId, contract: snapshot.contract }
  }
  const own =
    (await run(services.work.continuationContext(ctx.run.runId))) ??
    (await run(services.work.chatTask(ctx.run.sessionId)))?.task
  if (own === undefined)
    throw new ToolExecutionError(
      "This run works on no Task. Name one with key (from space_board_read or task_get).",
      { preview: "No Task here", retryable: false }
    )
  return { itemId: own.itemId, contract: own.contract }
}

const notFound = (): ToolExecutionError =>
  new ToolExecutionError("The Task is gone.", { preview: "Task not found", retryable: false })

const KIND_NAME: Record<ContractLine["kind"], string> = {
  rule: "rule",
  criterion: "done-when criterion",
  decision: "decision"
}

const savedLine = (contract: TaskContract, lineId: number): ContractLine => {
  const line = contract.lines.find((entry) => entry.lineId === lineId)
  if (line === undefined)
    throw new ToolExecutionError(
      `L${lineId} is not a saved line of this Task's contract. Read the Task contract and name one of its lines.`,
      { preview: "No such line", retryable: false }
    )
  return line
}

const proposalCard = (contract: TaskContract, change: ContractChange): RunQuestionContent => {
  if (change.kind === "retire") {
    const line = savedLine(contract, change.line_id)
    return {
      prompt: `Remove this ${KIND_NAME[line.kind]} from the Task?`,
      detail: line.text,
      choices: [{ id: "remove", label: "Remove" }]
    }
  }
  const replaced = change.replaces === undefined ? undefined : savedLine(contract, change.replaces)
  const kind = KIND_NAME[change.line.kind]
  return {
    prompt:
      replaced === undefined
        ? `Add this ${kind} to the Task?`
        : `Replace this ${kind} for the Task?`,
    detail: [
      ...(replaced === undefined ? [] : [`~~${replaced.text}~~`]),
      change.line.text,
      ...(change.line.kind === "decision" && change.line.rejected !== undefined
        ? [`Rejected: ${change.line.rejected}`]
        : [])
    ].join("  \n"),
    choices: [{ id: "save", label: "Save" }]
  }
}

const makeTaskContractTools = (services: TaskToolServices): ReadonlyArray<ServerTool> => [
  defineServerTool({
    name: "task_contract_propose",
    description:
      "Propose a change to a Task's contract from the owner's words in this turn: a standing rule, a done-when criterion, or a decision with the options it rejected; or the removal of a saved line. The owner sees a card with the line word for word, and with the saved line it contradicts when you name one in replaces; only their Save keeps it, as written: use the owner's exact words, and when they answer with other words, propose again with those. Propose when the owner states an order meant to hold for the Task, a measure of done, or a choice between options; not for one-off requests. You cannot change or remove a saved line yourself. Only the owner's own turn proposes: in a background run, ask the owner with ask_user, or wait on them with task_wait (waiting_on you), and the change is proposed in their turn. A rule about what Arden may do without asking is a permission: offer it with ask_user and permission, not here.",
    parameters: Schema.toStandardSchemaV1(ProposeParametersSchema),
    metadata: {
      effect: "run_record",
      display_name: "Propose Task line",
      kind: "tool",
      action: "write",
      source: "_spaces",
      changes_state: true,
      target: "reported",
      destructive: false,
      concurrency_group: "space_work",
      approval_preview: "Propose a line for a Task's contract."
    },
    execute: async (input, ctx, effects) => {
      if (ctx.run.authority.actor.kind !== "person")
        throw new ToolExecutionError(
          "Only the owner's own turn proposes a contract line. To add, remove or reword one, ask the owner with ask_user, or wait on them with task_wait (waiting_on you); the change is proposed in their turn.",
          { preview: "Not proposed", retryable: false }
        )
      const task = await resolveTask(services, ctx, input, "this_chat")
      const change: ContractChange =
        input.remove === undefined
          ? {
              kind: "add",
              line: input.line ?? missingLine(),
              ...(input.replaces === undefined ? {} : { replaces: input.replaces })
            }
          : { kind: "retire", line_id: input.remove }
      const content = proposalCard(task.contract, change)
      const question = await recordApplied(
        effects,
        Effect.runPromise(
          services.work
            .askQuestion({
              runId: ctx.run.runId,
              toolCallId: ctx.toolCallId,
              content,
              contractProposal: { itemId: task.itemId, change }
            })
            .pipe(Effect.mapError((error) => toolFailure(error, "Not proposed"))),
          { signal: ctx.signal }
        )
      )
      const chat = await Effect.runPromise(
        services.sessions.loadHistoryHeader(ctx.run.sessionId).pipe(
          Effect.map((header) => header ?? undefined),
          Effect.orElseSucceed(() => undefined)
        )
      )
      return {
        result: `Proposed (question_id ${question.question_id}): ${content.prompt} The owner sees it as a card; only their answer saves it, so do not say it is saved. Carry on with the work; their answer arrives at your next step.`,
        preview: content.prompt,
        data: { question },
        host: appliedReceipt(
          ctx,
          inChatTarget({
            resourceRef: `question:${question.question_id}`,
            title: content.prompt,
            chat
          })
        )
      }
    }
  }),
  defineServerTool({
    name: "task_criterion_met",
    description:
      "Record that one done-when criterion of a Task's contract is met, citing evidence the server resolves from its own records: a tool call of this Task's runs that succeeded (a command only with exit code 0), a file that exists, a result saved in the Task, or a link a run fetched with web_fetch. Anything it cannot resolve is refused with the reason; uncertain evidence means the criterion is not met. task_finish refuses done while a criterion has no recorded evidence.",
    parameters: Schema.toStandardSchemaV1(MeetParametersSchema),
    metadata: taskWriteMetadata("Meet Task criterion", "Record evidence for a Task criterion."),
    execute: async (input, ctx, effects) => {
      const task = await resolveTask(services, ctx, input, "reach")
      const met = await recordApplied(
        effects,
        Effect.runPromise(
          services.work
            .meetCriterion({
              itemId: task.itemId,
              lineId: input.line_id,
              evidence: input.evidence
            })
            .pipe(
              Effect.mapError((error) =>
                error.reason === "invalid" || error.reason === "not_found"
                  ? new ToolExecutionError(`Not recorded: ${error.message}`, {
                      preview: "Evidence refused",
                      retryable: false
                    })
                  : workFailure(error)
              )
            ),
          { signal: ctx.signal }
        )
      )
      const left =
        met.unmet === 0
          ? "Every done-when criterion is met; finish the Task with task_finish once its outcome is reached."
          : `${met.unmet} done-when ${met.unmet === 1 ? "criterion is" : "criteria are"} still unmet.`
      return {
        result: `Recorded for L${met.lineId}: ${evidenceWords(met.evidence)}. ${left}`,
        preview: `L${met.lineId} met`,
        data: { line_id: met.lineId, evidence: met.evidence, unmet: met.unmet }
      }
    }
  })
]

const missingLine = (): never => {
  throw new ToolExecutionError("Send line or remove.", {
    preview: "Nothing proposed",
    retryable: true
  })
}

export const taskContractTools = Effect.gen(function* () {
  return makeTaskContractTools({
    work: yield* WorkStore,
    sessions: yield* SessionQueries,
    spaces: yield* SpaceStore
  })
})

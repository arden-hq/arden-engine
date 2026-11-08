import {
  PauseRequested,
  ToolExecutionError,
  type ToolApprovalContext,
  type ToolApprovalGate,
  type ToolApprovalPrompt,
  type ToolResult
} from "@arden-hq/loop"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { Option, Schema } from "effect"
import { RuleSavedInSchema, type RuleSavedIn } from "@arden-hq/protocol/effect/runs"
import { homedir } from "node:os"
import type {
  ApprovalReview,
  ApprovalReviewAsk,
  ApprovalReviewInput,
  ApprovalReviewVerdict
} from "./approval-review.js"
import { decide, waivesRequirement, type CallFacts, type DenyRule } from "../execution/decide.js"
import { narrowerApprovalMode } from "@arden-hq/protocol/permissions"
import { isRefusal, refusalError, withBreaker } from "./refusal.js"
import { commandFacts, toolFacts } from "./approval-decision.js"
import { toolRule, type LiveRead } from "./approval-policy.js"
import { wordsRules } from "../execution/rules.js"
import { COMMAND_TOOL } from "../persistence/permissions/command-policy.js"
import { withHelperRule } from "./shell-policy.js"
import { impactOf, shellCommandOf, siteOf, type ServerToolMetadataInput } from "./define.js"
import { defaultImpact } from "../execution/impact.js"
import { TOOL_SUMMARIES } from "./tool-summaries.js"
import { NOT_RUN_HOST } from "../persistence/tools/mutation-receipt.js"
import type { ServerRunContext } from "./run-context.js"

type ApprovalFact =
  | {
      readonly by: "user"
      readonly decision: "approved"
      readonly saved_rule?: true
      readonly saved_in?: RuleSavedIn
      readonly edited?: true
    }
  | { readonly by: "mode"; readonly decision: "approved"; readonly mode: "safe" | "allow" }
  | { readonly by: "helper"; readonly decision: "approved"; readonly reason: string }

export interface ApprovalGatePolicy {
  readonly live: (run: ServerRunContext) => Promise<LiveRead>
  readonly reach: (input: {
    readonly run: ServerRunContext
    readonly name: string
    readonly live: LiveRead
  }) => Pick<CallFacts, "available" | "unattended_scope">
  readonly defer: (input: {
    readonly run: ServerRunContext
    readonly toolCallId: string
    readonly name: string
    readonly args: unknown
    readonly changesState: boolean
    readonly prompt: ToolApprovalPrompt
  }) => Promise<void>
  readonly offer: (input: {
    readonly run: ServerRunContext
    readonly toolCallId: string
    readonly name: string
    readonly site: string | undefined
  }) => Promise<void>
  readonly refusals: (input: {
    readonly run: ServerRunContext
    readonly name: string
  }) => Promise<number>
}

export const makeApprovalGate =
  (services: {
    readonly review: ApprovalReview
    readonly policy: ApprovalGatePolicy
  }): ToolApprovalGate<ServerRunContext, ServerToolMetadataInput> =>
  async (call, execute) => {
    const { definition, input } = call
    const live = await services.policy.live(call.ctx.run)
    const mode = live.noApproval ? narrowerApprovalMode(live.mode, "ask") : live.mode
    const ctx = { ...call.ctx, run: { ...call.ctx.run, approvalMode: mode } }
    const refused = async (cause: unknown): Promise<never> => {
      const result =
        live.noApproval &&
        cause instanceof PauseRequested &&
        (cause.reason === "approval" || cause.reason === "connection")
          ? refusalError({
              what: `${definition.name} needs attention and cannot run in a Side chat`,
              rule: "floor",
              instead: []
            })
          : cause
      if (!isRefusal(result)) throw result
      throw withBreaker(
        result,
        await services.policy.refusals({ run: ctx.run, name: definition.name })
      )
    }
    const forced = definition.metadata.always_ask === true
    const shell = shellCommandOf(definition)
    const command = commandFacts(
      shell === undefined ? undefined : await shell(input, ctx).catch(refused),
      homedir()
    )
    const requirement = definition.approvalRequirement
    const required =
      requirement === undefined ||
      command.floor !== undefined ||
      waivesRequirement(mode, definition.metadata)
        ? undefined
        : await Promise.resolve()
            .then(() => requirement(input, ctx))
            .catch(refused)
    const site = siteOf(definition)?.(input)
    const rule = toolRule(live, definition, site)
    const facts = toolFacts(definition)
    const impact = impactOf(definition)?.(input, ctx) ?? defaultImpact(facts)
    const decision = decide(
      ctx.run.authority,
      { state: live.state, mode, rule },
      {
        tool: facts,
        ...services.policy.reach({ run: ctx.run, name: definition.name, live }),
        ...command,
        target: undefined,
        requirement: required !== undefined,
        user_only: required !== undefined && userOnlyCard(required),
        impact,
        approved: ctx.approval !== undefined
      }
    )
    if (live.noApproval && (decision.kind === "ask" || ctx.approval !== undefined))
      return refused(
        refusalError({
          what: `${definition.name} needs approval and cannot run in a Side chat`,
          rule: "floor",
          instead: []
        })
      )
    if (decision.kind === "deny")
      return refused(
        refusalError({
          what: `${definition.name} is not allowed in this run: ${DENY_REASON[decision.rule]}`,
          rule: decision.rule,
          instead: decision.instead
        })
      )
    if (decision.kind === "ask") {
      const prompt =
        required ??
        (definition.approvalPrompt === undefined
          ? {
              preview:
                definition.metadata.approval_preview ??
                TOOL_SUMMARIES[definition.name] ??
                definition.description
            }
          : await definition.approvalPrompt(input, ctx))
      const reviewOf = (
        call: Pick<ApprovalReviewInput, "name" | "description" | "args" | "category" | "prompt">
      ) =>
        services.review({
          ...call,
          run: ctx.run,
          toolCallId: ctx.toolCallId,
          rung: decision.reason,
          changesState: definition.metadata.changes_state,
          ownerRules: wordsRules(live.rules),
          messages: ctx.messages,
          signal: ctx.signal
        })
      const plan = ctx.run.reviewPlans.reviewOf(ctx.toolCallId)
      const review = decision.presentation.helper
        ? await (
            plan === undefined
              ? reviewOf({
                  name: definition.name,
                  description: definition.description,
                  args: input,
                  category: impact.kind === "outward" ? impact.category : "unknown",
                  prompt
                })
              : plan((whole) =>
                  reviewOf({
                    name: whole.name,
                    description: whole.description,
                    args: whole.args,
                    category: "unknown",
                    prompt: { preview: whole.preview }
                  })
                )
          ).catch((): ApprovalReviewVerdict => ({ verdict: "ask", why: { kind: "failed" } }))
        : undefined
      if (review?.verdict !== "allow") {
        if (decision.presentation.delivery === "refuse") throw liveStateRefusal()
        const note = cardNote(decision.reason, review?.why)
        const noted = note === undefined ? prompt : withWhy(prompt, note)
        const rule = review?.verdict === "ask" ? helperRule(review.why) : undefined
        const card =
          definition.name === COMMAND_TOOL && rule !== undefined
            ? withHelperRule(noted, rule)
            : noted
        if (decision.presentation.delivery === "chat") {
          const kept = await services.policy
            .defer({
              run: ctx.run,
              toolCallId: ctx.toolCallId,
              name: definition.name,
              args: input,
              changesState: definition.metadata.changes_state,
              prompt: card
            })
            .then(
              () => true,
              () => false
            )
          throw kept ? waitsInChat() : unattendedRefusal()
        }
        throw new PauseRequested("approval", card.preview, card)
      }
      ctx.signal.throwIfAborted()
      const result = await execute({ ...ctx, approval: helperApproval(prompt) }).catch(refused)
      return withApprovalFact(result, { by: "helper", decision: "approved", reason: review.reason })
    }
    const result = await execute(ctx).catch(refused)
    if (decision.kind === "allow" && decision.by === "user")
      await services.policy.offer({
        run: ctx.run,
        toolCallId: ctx.toolCallId,
        name: definition.name,
        site
      })
    const wouldAsk =
      impact.kind !== "inert" &&
      (required !== undefined ||
        definition.approvalRequirement !== undefined ||
        rule === "ask" ||
        forced ||
        definition.metadata.default_approval === "ask")
    return withApprovalFact(result, approvalFact(ctx.approval, mode, wouldAsk))
  }

const DENY_REASON: Record<DenyRule, string> = {
  revoked: "this run no longer has authority",
  settling: "this run's Task is finished; say your closing reply",
  user_deny: "the user turned this tool off",
  floor: "the command could erase the whole machine, the home folder or a disk",
  reach: "it is outside what this run may use",
  boundary: "it reaches outside what this run owns",
  read_only: "this run is read-only"
}

const userOnlyCard = (prompt: ToolApprovalPrompt): boolean => prompt.data?.["reviewer"] === "user"

const UNATTENDED_REFUSAL =
  "This needs the user's approval, and no one can give it during this run, so it did not run. Skip this step, finish the rest of the work, and say in your report that it waits on the user's approval."

const waitsInChat = () =>
  new ToolExecutionError(
    "This needs the user's approval, so it did not run now. Its card waits for them in this run's chat, and approving it there runs this call then. Do not repeat it: finish the rest of the work, and say in your report that it waits on the user's approval.",
    { preview: "Waits on the user's approval", retryable: false, host: NOT_RUN_HOST }
  )

const liveStateRefusal = () =>
  new ToolExecutionError(
    "This needs the user's approval, and it acts on something that can change before they could give it (a running command, an open page or window), so it did not run and no card was kept. Skip this step, finish the rest of the work, and say in your report that this step must be done while the user is there to approve it.",
    { preview: "Not run: no one to approve it", retryable: false, host: NOT_RUN_HOST }
  )

const unattendedRefusal = () =>
  new ToolExecutionError(UNATTENDED_REFUSAL, {
    preview: "Waits on the user's approval",
    retryable: false,
    host: NOT_RUN_HOST
  })

const helperRule = (why: ApprovalReviewAsk): string | undefined =>
  why.kind === "judged" ? why.rule : undefined

const helperNote = (why: ApprovalReviewAsk): string | undefined =>
  why.kind === "judged" ? why.reason : undefined

const STANDING_NOTE =
  "Your automations always ask before they change directives, skills, automations or permissions."

const cardNote = (reason: string, why: ApprovalReviewAsk | undefined): string | undefined => {
  if (why !== undefined) return helperNote(why)
  return reason === "standing" ? STANDING_NOTE : undefined
}

const withWhy = (prompt: ToolApprovalPrompt, note: string): ToolApprovalPrompt =>
  typeof prompt.presentation === "object" && prompt.presentation !== null
    ? { ...prompt, presentation: { ...prompt.presentation, why: note } }
    : prompt

const helperApproval = (prompt: ToolApprovalPrompt): ToolApprovalContext => ({
  approved: true,
  reviewer: true,
  feedback: null,
  ...(prompt.data === undefined ? {} : { data: prompt.data })
})

const approvalFact = (
  approval: ToolApprovalContext | undefined,
  mode: ChatApprovalMode,
  wouldAsk: boolean
): ApprovalFact | undefined => {
  if (approval !== undefined) {
    return {
      by: "user",
      decision: "approved",
      ...(approval.grantStanding === true ? { saved_rule: true } : {}),
      ...Option.match(Schema.decodeUnknownOption(RuleSavedInSchema)(approval.data?.["saved_in"]), {
        onNone: () => ({}),
        onSome: (savedIn) => ({ saved_in: savedIn })
      }),
      ...(approval.edited === undefined ? {} : { edited: true })
    }
  }
  // oxlint-disable-next-line arden/restricted-owner -- names the mode that let the call through, after decide()
  if (wouldAsk && (mode === "safe" || mode === "allow"))
    return { by: "mode", decision: "approved", mode }
  return undefined
}

const withApprovalFact = (
  result: Required<ToolResult>,
  fact: ApprovalFact | undefined
): Required<ToolResult> =>
  fact === undefined ? result : { ...result, data: { ...result.data, approval: fact } }

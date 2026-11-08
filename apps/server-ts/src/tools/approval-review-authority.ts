import { Buffer } from "node:buffer"
import { isUserAutomation, type Actor } from "../execution/authority.js"
import { Effect, Predicate } from "effect"
import { runPolicyOf } from "../execution/policy.js"
import type {
  AutomationCatalog,
  AutomationDelegation,
  AutomationInstructionRevision
} from "../persistence/automations/catalog.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import { sessionLineage, spawnClientId } from "../persistence/sessions/lineage.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import { ownerText } from "../persistence/transcript/owner-words.js"
import type { TranscriptQueries } from "../persistence/transcript/queries.js"
import type { TaskIntent, WorkStore } from "../persistence/work/store.js"

export const MAX_REVIEW_BYTES = 128_000

interface DelegationBrief {
  readonly from: string
  readonly text: string
}

interface OwnerRequest {
  readonly sessionId: string
  readonly messageId: string
  readonly text: string
  readonly updates: ReadonlyArray<string>
}

interface DelegationWords {
  readonly sessionId: string
  readonly words: ReadonlyArray<string>
}

export interface TrustedAuthority {
  readonly ownerRequest: OwnerRequest | undefined
  readonly delegationRequests: ReadonlyArray<OwnerRequest>
  readonly delegationWords: ReadonlyArray<DelegationWords>
  readonly ownerWords: ReadonlyArray<string>
  readonly automationPrompt: AutomationDelegation | undefined
  readonly briefs: ReadonlyArray<DelegationBrief>
  readonly task: TaskIntent | undefined
}

export const assignmentBrief = (
  envelopes: ReadonlyArray<Readonly<Record<string, unknown>>>
): DelegationBrief | undefined => {
  for (const envelope of envelopes) {
    const interaction = envelope["interaction"]
    if (envelope["role"] !== "user" || !Predicate.isObject(interaction)) continue
    if (interaction["kind"] !== "assignment" || !Predicate.isString(interaction["content"]))
      continue
    const from = interaction["from"]
    const name =
      Predicate.isObject(from) && Predicate.isString(from["display_name"])
        ? from["display_name"]
        : "the agent that started this run"
    return { from: name, text: interaction["content"] }
  }
  return undefined
}

interface ReviewedRun {
  readonly runId: string
  readonly sessionId: string
  readonly taskItemId: string | null
}

export type TrustedAuthorityReader = (run: ReviewedRun) => Promise<TrustedAuthority>

const ownerWordsOf = (
  envelopes: ReadonlyArray<Readonly<Record<string, unknown>>>
): ReadonlyArray<string> =>
  envelopes.flatMap((message) => {
    const text = ownerText(message)
    return text.length === 0 ? [] : [text]
  })

export const approvalReviewAuthority =
  (stores: {
    readonly runs: RunQueries["Service"]
    readonly sessions: SessionQueries["Service"]
    readonly transcript: TranscriptQueries["Service"]
    readonly automations: AutomationCatalog["Service"]
    readonly work: WorkStore["Service"]
  }): TrustedAuthorityReader =>
  ({ runId, sessionId, taskItemId }) => {
    const { runs, sessions, transcript, automations, work } = stores
    return Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* runs.get(runId)
        const captured = current === null ? null : yield* runPolicyOf(current)
        const root = yield* sessions.loadHistoryHeader(captured?.authority_session_id ?? sessionId)
        const origin = yield* executionOrigin(runs, runId)
        const ownerRequest =
          origin?.actor.kind === "person"
            ? yield* originatingRequest(transcript, origin.actor)
            : undefined
        const delegation =
          origin != null && isUserAutomation(origin.actor)
            ? yield* automationDelegation(
                runs,
                transcript,
                automations,
                origin.runId,
                origin.actor.automation_id
              )
            : { prompt: undefined, requests: [], words: [] }
        const owner = yield* Effect.gen(function* () {
          if (root === null) return { words: [] }
          const type = root.sessionType
          if (type !== "chat" && type !== "channel") return { words: [] }
          const conversation = yield* transcript.conversationPage({
            _tag: "Latest",
            sessionId: root.sessionId,
            limit: 250
          })
          const words = ownerWordsOf(conversation.records.map((record) => record.envelope))
          return { words }
        })
        const lineage = yield* sessionLineage(sessions, sessionId).pipe(
          Effect.orElseSucceed(() => [])
        )
        const briefs: DelegationBrief[] = []
        for (const header of lineage) {
          if (
            header.sessionType !== "agent" ||
            header.parentRunId === null ||
            header.parentToolCallId === null
          )
            continue
          const sequence = yield* transcript.resolveConversationReference(
            header.sessionId,
            spawnClientId(header.parentRunId, header.parentToolCallId)
          )
          if (sequence === null) continue
          const opening = yield* transcript.conversationPage({
            _tag: "After",
            sessionId: header.sessionId,
            sequence: sequence - 1,
            limit: 1
          })
          const brief = assignmentBrief(opening.records.map((record) => record.envelope))
          if (brief !== undefined) briefs.unshift(brief)
        }
        const task =
          taskItemId === null
            ? undefined
            : yield* work.taskIntent(taskItemId).pipe(Effect.orElseSucceed(() => undefined))
        return {
          ownerRequest,
          delegationRequests: delegation.requests,
          delegationWords: delegation.words,
          ownerWords: owner.words,
          automationPrompt: delegation.prompt,
          briefs,
          task
        }
      })
    )
  }

const executionOrigin = Effect.fn("ApprovalReview.executionOrigin")(function* (
  runs: RunQueries["Service"],
  runId: string
): Effect.fn.Return<{ readonly actor: Actor; readonly runId: string } | undefined, Error> {
  const seen = new Set<string>()
  let next = runId
  while (true) {
    if (seen.has(next) || seen.size >= 64)
      return yield* Effect.fail(new Error("Approval execution lineage is cyclic or too deep"))
    seen.add(next)
    const authority = yield* runs.authority(next)
    if (authority === undefined) return undefined
    const actor = authority.actor
    if (actor.kind === "agent") {
      next = actor.parent_run_id
      continue
    }
    const run = yield* runs.get(next)
    if (run === null || (actor.kind === "person" && run.sessionId !== actor.session_id))
      return undefined
    return { actor, runId: next }
  }
})

const automationDelegation = Effect.fn("ApprovalReview.automationDelegation")(function* (
  runs: RunQueries["Service"],
  transcript: TranscriptQueries["Service"],
  automations: AutomationCatalog["Service"],
  rootRunId: string,
  automationId: string
): Effect.fn.Return<
  {
    readonly prompt: AutomationDelegation | undefined
    readonly requests: ReadonlyArray<OwnerRequest>
    readonly words: ReadonlyArray<DelegationWords>
  },
  Error
> {
  const first = yield* instructionForRootRun(runs, automations, rootRunId)
  if (first === null || first.automationId !== automationId)
    return { prompt: undefined, requests: [], words: [] }
  const requests: OwnerRequest[] = []
  const active = new Set<number>()
  const visit = Effect.fn("ApprovalReview.visitInstruction")(function* (
    revision: AutomationInstructionRevision,
    depth: number
  ): Effect.fn.Return<void, Error> {
    if (depth >= 64 || active.has(revision.revisionId))
      return yield* Effect.fail(
        new Error("Automation instruction provenance is cyclic or too deep")
      )
    active.add(revision.revisionId)
    if (revision.source === undefined) {
      if (revision.author !== "owner")
        return yield* Effect.fail(new Error("Automation instruction has no owner or write source"))
      active.delete(revision.revisionId)
      return
    }
    const source = yield* executionOrigin(runs, revision.source.runId)
    if (source === undefined)
      return yield* Effect.fail(new Error("Automation write source has no execution origin"))
    if (source?.actor.kind === "person") {
      const request = yield* originatingRequest(transcript, source.actor)
      if (request === undefined)
        return yield* Effect.fail(new Error("Automation write source has no owner request"))
      requests.push(request)
      active.delete(revision.revisionId)
      return
    }
    if (!isUserAutomation(source.actor))
      return yield* Effect.fail(new Error("Automation write source has no user delegation"))
    const parent = yield* instructionForRootRun(runs, automations, source.runId)
    if (parent === null || parent.automationId !== source.actor.automation_id)
      return yield* Effect.fail(new Error("Automation source run has no captured instruction"))
    yield* visit(parent, depth + 1)
    active.delete(revision.revisionId)
  })
  yield* visit(first, 0)
  const words: DelegationWords[] = []
  let bytes = 0
  for (const sessionId of new Set(requests.map((request) => request.sessionId))) {
    const all: string[] = []
    let cursor = 0
    while (true) {
      const page = yield* transcript.ownerMessagesAfter({ sessionId, sequence: cursor, limit: 250 })
      for (const message of page) {
        const text = ownerText(message.envelope)
        if (text.trim().length === 0) continue
        bytes += Buffer.byteLength(text, "utf8")
        if (bytes > MAX_REVIEW_BYTES)
          return yield* Effect.fail(
            new Error("Complete Automation owner context exceeds review budget")
          )
        all.push(text)
      }
      const last = page[page.length - 1]
      if (page.length < 250 || last === undefined) break
      if (last.sequence <= cursor)
        return yield* Effect.fail(new Error("Automation owner-message cursor did not advance"))
      cursor = last.sequence
    }
    words.push({ sessionId, words: all })
  }
  return {
    prompt: { prompt: first.prompt, author: first.author },
    requests,
    words
  }
})

const instructionForRootRun = Effect.fn("ApprovalReview.instructionForRootRun")(function* (
  runs: RunQueries["Service"],
  automations: AutomationCatalog["Service"],
  rootRunId: string
): Effect.fn.Return<AutomationInstructionRevision | null, Error> {
  const run = yield* runs.get(rootRunId)
  if (run === null) return null
  const policy = yield* runPolicyOf(run)
  const revisionId = policy.automation_instruction_revision_id
  if (revisionId === undefined) return null
  return yield* automations.instructionRevision(revisionId)
})

const originatingRequest = Effect.fn("ApprovalReview.originatingRequest")(function* (
  transcript: TranscriptQueries["Service"],
  actor: Extract<Actor, { readonly kind: "person" }>
): Effect.fn.Return<TrustedAuthority["ownerRequest"], Error> {
  const sequence = yield* transcript.resolveReference(actor.session_id, actor.turn_id)
  if (sequence === null) return undefined
  const page = yield* transcript.page({
    _tag: "After",
    sessionId: actor.session_id,
    sequence: sequence - 1,
    limit: 1
  })
  const record = page.records[0]
  if (
    record === undefined ||
    record.sequence !== sequence ||
    record.sessionId !== actor.session_id ||
    record.messageId !== actor.turn_id
  )
    return undefined
  const text = ownerText(record.envelope)
  if (text.trim().length === 0) return undefined
  const updates: string[] = []
  let bytes = Buffer.byteLength(text, "utf8")
  let cursor = sequence
  while (true) {
    if (bytes > MAX_REVIEW_BYTES)
      return yield* Effect.fail(new Error("Complete owner evidence exceeds review budget"))
    const page = yield* transcript.ownerMessagesAfter({
      sessionId: actor.session_id,
      sequence: cursor,
      limit: 250
    })
    for (const update of page) {
      const words = ownerText(update.envelope)
      if (words.trim().length === 0) continue
      bytes += Buffer.byteLength(words, "utf8")
      if (bytes > MAX_REVIEW_BYTES)
        return yield* Effect.fail(new Error("Complete owner evidence exceeds review budget"))
      updates.push(words)
    }
    const last = page[page.length - 1]
    if (page.length < 250 || last === undefined) break
    if (last.sequence <= cursor)
      return yield* Effect.fail(new Error("Owner-message cursor did not advance"))
    cursor = last.sequence
  }
  return {
    sessionId: actor.session_id,
    messageId: record.messageId,
    text,
    updates
  }
})

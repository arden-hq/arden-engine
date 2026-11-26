import { parseJsonTextOrUndefined } from "@arden-hq/protocol/common"
import { HeadlessHttpError, type HeadlessRunEvent } from "@arden-hq/headless"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { grantedOnlyInTheApp, type ToolCatalogResponse } from "@arden-hq/protocol/tools"
import { runDecoders, type RunQuestion } from "@arden-hq/protocol/runs"
import { errorMessage } from "@arden-hq/std/errors"
import { sleep } from "@arden-hq/std/sleep"
import { clipLine, cutText } from "@arden-hq/std/text"
import { randomUUID } from "node:crypto"

import { plainHttpMessage, type CliClient, type CliDependencies } from "./command.js"
import type { ApprovalHandling, CliOutputFormat, DeclinedRequest } from "./run.js"

export const progressLines = (): ((event: HeadlessRunEvent) => string | undefined) => {
  const calls = new Map<string, { readonly name: string; args: string }>()
  const named = new Set<string>()
  return (event) => {
    const data = event.data
    if (data.type === "RUN_ERROR") return `error: ${data.message}`
    if (data.type === "run_cancelled") return "the Run was cancelled"
    if (data.type === "TOOL_CALL_START") {
      if (named.has(data.tool_call_id)) return undefined
      const name = data.display_name ?? data.tool_call_name
      const title = data.display_title
      calls.set(data.tool_call_id, {
        name: title === undefined || title === "" || title === name ? name : `${name} · ${title}`,
        args: ""
      })
      return undefined
    }
    if (data.type === "TOOL_CALL_ARGS") {
      const call = calls.get(data.tool_call_id)
      if (call !== undefined) call.args += data.delta
      return undefined
    }
    if (data.type !== "TOOL_CALL_END") return undefined
    const call = calls.get(data.tool_call_id)
    if (call === undefined) return undefined
    calls.delete(data.tool_call_id)
    named.add(data.tool_call_id)
    const key = keyArgument(call.args)
    return key === undefined || call.name.includes("·") ? call.name : `${call.name} · ${key}`
  }
}

const KEY_ARGUMENTS = ["command", "cmd", "query", "q", "path", "url", "prompt", "name"] as const

const keyArgument = (args: string): string | undefined => {
  const parsed = parseJsonTextOrUndefined(args)
  if (typeof parsed !== "object" || parsed === null) return undefined
  const fields: Readonly<Record<string, unknown>> = { ...parsed }
  const value = KEY_ARGUMENTS.map((key) => fields[key]).find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== ""
  )
  return value === undefined ? undefined : clipLine(value, 80)
}

const DECLINED_NOTE =
  "No one was at the command line to answer this, so it was declined. Carry on without it."

type ApprovalChoice = "allow_once" | "always_allow" | "deny" | "leave"

const approvalLabel = (choice: ApprovalChoice): string => {
  switch (choice) {
    case "allow_once":
      return DECISION_WORD.allowOnce
    case "always_allow":
      return DECISION_WORD.alwaysAllow
    case "deny":
      return DECISION_WORD.deny
    case "leave":
      return "Leave it waiting"
  }
}

type CardKind = "app_only" | "ordinary" | "unknown"

const cardNote = (card: CardKind): string | undefined => {
  switch (card) {
    case "ordinary":
      return undefined
    case "app_only":
      return "Only the Arden app can allow this."
    case "unknown":
      return "Arden could not check whether this can be allowed from here, so it cannot be allowed here. If this keeps happening, update Arden."
  }
}

const approvalChoices = (card: CardKind, standing: boolean): Array<ApprovalChoice> => {
  if (card !== "ordinary") return ["deny", "leave"]
  return standing ? ["allow_once", "always_allow", "deny"] : ["allow_once", "deny"]
}

type ConnectionChoice = "connected" | "skip"

const CONNECTION_LABELS: Record<ConnectionChoice, string> = {
  connected: "I connected it in Arden, go on",
  skip: "Skip it"
}

const SKIP_QUESTION = "Answer later in Arden"
const NEXT_RUN_ATTEMPTS = 40
const NEXT_RUN_POLL_MS = 250

export interface RunResponder {
  readonly onEvent: (event: HeadlessRunEvent, signal?: AbortSignal) => Promise<void>
  readonly afterRun: () => Promise<string | undefined>
}

export const requestResponder = (input: {
  readonly client: CliClient
  readonly runId: string
  readonly handling: ApprovalHandling
  readonly output: CliOutputFormat
  readonly dependencies: CliDependencies
  readonly declined: Array<DeclinedRequest>
}): RunResponder => {
  const handled = new Set<string>()
  const runs = new Set([input.runId])
  const questions: Array<RunQuestion> = []
  const say = (line: string): void => {
    if (input.output === "text") input.dependencies.writeStderr(`arden: ${line}\n`)
  }
  const ask = input.handling === "decline" ? undefined : input.dependencies.askInTerminal
  const toolNames = new Map<string, string>()
  const toolName = (toolId: string, fallback: string): string => toolNames.get(toolId) ?? fallback
  const unanswered = (data: HeadlessRunEvent["data"], runId: string, name: string) =>
    input.handling === "ask_then_decline" ? decline(data, runId) : wait(name)
  const choose = async <Choice extends string>(
    heading: string,
    choices: ReadonlyArray<readonly [Choice, string]>
  ): Promise<Choice | undefined> => {
    if (ask === undefined) return undefined
    const menu = choices.map(([, label], index) => `  ${index + 1}) ${label}`).join("\n")
    let answer = await ask(`${heading}\n${menu}\nChoose 1-${choices.length}: `)
    for (;;) {
      if (answer === undefined) return undefined
      const picked = choices[Number(answer.trim()) - 1]
      if (picked !== undefined && /^\d+$/.test(answer.trim())) return picked[0]
      answer = await ask(`Type a number from 1 to ${choices.length}: `)
    }
  }

  let catalog: ToolCatalogResponse | undefined
  const displayIn = (read: ToolCatalogResponse | undefined, tool: string) =>
    read?.tools.find((listed) => listed.name === tool)?.display ?? read?.unlisted[tool]
  const cardOf = async (tool: string, signal: AbortSignal | undefined): Promise<CardKind> => {
    if (displayIn(catalog, tool) === undefined)
      catalog =
        (await input.client
          .toolCatalog(signal === undefined ? {} : { signal })
          .catch((cause: unknown) => {
            if (signal?.aborted === true) throw cause
            return undefined
          })) ?? catalog
    const display = displayIn(catalog, tool)
    if (display === undefined) return "unknown"
    return grantedOnlyInTheApp(display) ? "app_only" : "ordinary"
  }

  const answerApproval = async (
    data: Extract<HeadlessRunEvent["data"], { type: "approval_needed" }>,
    runId: string,
    signal: AbortSignal | undefined
  ): Promise<void> => {
    const card = ask === undefined ? "unknown" : await cardOf(data.name, signal)
    const offered = approvalChoices(card, (data.rule_places ?? []).length > 0)
    const note = cardNote(card)
    const presentation = data.presentation
    const shown = [
      ...(presentation?.fields ?? []).map((field) => `${field.label}: ${field.value}`),
      ...(presentation?.body === undefined ? [] : [presentation.body.text]),
      data.path,
      data.content_preview
    ]
      .filter((line): line is string => typeof line === "string" && line.length > 0)
      .map((line) => `  ${clip(line)}`)
    const name = toolName(data.tool_id, data.name)
    const title = presentation?.title ?? `Arden asks to run ${name}.`
    const choice = await choose(
      [note === undefined ? title : `${title} ${note}`, ...shown].join("\n"),
      offered.map((value) => [value, approvalLabel(value)] as const)
    )
    if (choice === undefined) return unanswered(data, runId, name)
    if (choice === "leave") return say(`${name} stays waiting.`)
    await input.client.answerApproval({
      ...answering(data, runId),
      result: "",
      approved: choice !== "deny",
      grantStanding: choice === "always_allow"
    })
    say(`${approvalLabel(choice)}: ${name}`)
  }

  const answerConnection = async (
    data: Extract<HeadlessRunEvent["data"], { type: "connection_needed" }>,
    runId: string
  ): Promise<void> => {
    const choice = await choose(
      `Arden needs ${data.label} connected: ${data.detail}`,
      (["connected", "skip"] as const).map((value) => [value, CONNECTION_LABELS[value]] as const)
    )
    if (choice === undefined) return unanswered(data, runId, data.label)
    await input.client.answerConnection({
      runId,
      toolId: data.tool_id,
      connectionId: data.connection_id,
      approved: choice === "connected"
    })
    say(`${CONNECTION_LABELS[choice]}: ${data.label}`)
  }

  const wait = (name: string): void => {
    say(
      `${name} waits for an answer in Arden. To decline instead, run again with --no-wait-approval.`
    )
  }

  const decline = async (data: HeadlessRunEvent["data"], runId: string): Promise<void> => {
    if (data.type !== "approval_needed" && data.type !== "connection_needed") return
    const name = data.type === "approval_needed" ? toolName(data.tool_id, data.name) : data.label
    try {
      if (data.type === "approval_needed") {
        await input.client.answerApproval({
          ...answering(data, runId),
          result: DECLINED_NOTE,
          approved: false
        })
      } else {
        await input.client.answerConnection({
          runId,
          toolId: data.tool_id,
          connectionId: data.connection_id,
          result: DECLINED_NOTE,
          approved: false
        })
      }
      input.declined.push({
        kind: data.type === "approval_needed" ? "approval" : "connection",
        tool_id: data.tool_id,
        name
      })
      say(`declined ${name}: no one is here to answer it`)
    } catch (cause) {
      say(`could not decline ${name}: ${plainError(cause)}`)
    }
  }

  const answerQuestion = async (question: RunQuestion): Promise<string | undefined> => {
    const content = question.content
    const heading = [
      `Arden asks: ${content.prompt}`,
      ...(content.detail === null ? [] : [`  ${clip(content.detail)}`])
    ].join("\n")
    if (ask === undefined) return undefined
    const answer =
      content.choices.length === 0
        ? await typedAnswer(heading)
        : await choose(heading, [
            ...content.choices.map((choice) => [choice.id, choice.label] as const),
            ["", SKIP_QUESTION] as const
          ])
    if (answer === undefined || answer === "") {
      say("The question stays open in Arden.")
      return undefined
    }
    const resolved = await input.client.answerQuestion(question.question_id, {
      client_id: randomUUID(),
      answer:
        content.choices.length === 0
          ? { kind: "text", text: answer }
          : { kind: "choice", choice_id: answer }
    })
    const continuation = resolved.continuation
    const next =
      continuation?.kind === "started" ? continuation.run_id : await nextRunIn(question.session_id)
    if (next === undefined || runs.has(next)) {
      say("The answer goes to Arden's next turn in this chat.")
      return undefined
    }
    runs.add(next)
    return next
  }

  const nextRunIn = async (sessionId: string): Promise<string | undefined> => {
    for (let attempt = 0; attempt < NEXT_RUN_ATTEMPTS; attempt += 1) {
      const { sessions } = await input.client.listSessions({ live: true })
      const active = sessions.find((session) => session.session_id === sessionId)?.active_run_id
      if (typeof active === "string" && !runs.has(active)) return active
      await sleep(NEXT_RUN_POLL_MS)
    }
    return undefined
  }

  const typedAnswer = async (heading: string): Promise<string | undefined> => {
    if (ask === undefined) return undefined
    const text = await ask(`${heading}\nYour answer (empty to answer later in Arden): `)
    return text?.trim()
  }

  return {
    afterRun: async () => {
      for (let question = questions.shift(); question !== undefined; question = questions.shift()) {
        const next = await answerQuestion(question)
        if (next !== undefined) return next
      }
      return undefined
    },
    onEvent: async (event, signal) => {
      const data = event.data
      if (data.type === "TOOL_CALL_START")
        toolNames.set(data.tool_call_id, data.display_name ?? data.tool_call_name)
      const runId = "run_id" in data && typeof data.run_id === "string" ? data.run_id : input.runId
      if (!runs.has(runId)) return
      if (data.type === "TOOL_CALL_RESULT") {
        const question = questionOf(data.data)
        if (question === undefined || handled.has(question.question_id)) return
        handled.add(question.question_id)
        if (ask === undefined) say(`question: ${question.content.prompt} (answer it in Arden)`)
        else questions.push(question)
        return
      }
      if (data.type !== "approval_needed" && data.type !== "connection_needed") return
      if (handled.has(data.tool_id)) return
      handled.add(data.tool_id)
      if (input.handling === "decline") return decline(data, runId)
      if (data.type === "approval_needed") return answerApproval(data, runId, signal)
      return answerConnection(data, runId)
    }
  }
}

const answering = (
  card: Extract<HeadlessRunEvent["data"], { type: "approval_needed" }>,
  runId: string
) => ({
  runId,
  toolId: card.tool_id,
  ...(card.asked_at === undefined ? {} : { askedAt: card.asked_at })
})

const plainError = (cause: unknown): string =>
  cause instanceof HeadlessHttpError ? plainHttpMessage(cause) : errorMessage(cause)

const questionOf = (value: unknown): RunQuestion | undefined => {
  if (typeof value !== "object" || value === null || !("question" in value)) return undefined
  try {
    return runDecoders.question(value.question)
  } catch {
    return undefined
  }
}

const clip = (text: string): string => cutText(text.split("\n").slice(0, 6).join("\n  "), 600)

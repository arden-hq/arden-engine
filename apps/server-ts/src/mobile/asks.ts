import { previewLine } from "@arden-hq/protocol/chat"
import type { MobileAsk, MobileChange } from "@arden-hq/protocol/mobile"
import type { RunApproval, RunQuestion } from "@arden-hq/protocol/runs"
import { namedTool } from "@arden-hq/protocol/views"

export interface AskPlace {
  readonly name: string | undefined
  readonly spaceId: string | undefined
  readonly home: boolean
  readonly onboarding: boolean
}

export function mobileAsks({
  questions,
  approvals,
  places,
  spaceNames
}: {
  readonly questions: ReadonlyArray<RunQuestion>
  readonly approvals: ReadonlyArray<RunApproval>
  readonly places: ReadonlyMap<string, AskPlace>
  readonly spaceNames: ReadonlyMap<string, string>
}): MobileAsk[] {
  const where = (sessionId: string) => {
    const place = places.get(sessionId)
    const spaceId = place?.spaceId
    const spaceName = spaceId === undefined ? undefined : spaceNames.get(spaceId)
    return {
      session_id: sessionId,
      space_id: spaceId ?? null,
      place: (place?.home === true ? spaceName : place?.name?.trim()) || spaceName || "untitled"
    }
  }
  const open = questions.filter(
    (question) =>
      question.status === "open" && places.get(question.destination_session_id)?.onboarding !== true
  )
  const question = (asked: RunQuestion): MobileAsk => ({
    kind: "question",
    question_id: asked.question_id,
    run_id: asked.run_id,
    ...where(asked.destination_session_id),
    asked_at: asked.created_at,
    prompt: asked.content.prompt,
    detail: asked.content.detail,
    multiple: asked.content.multiple === true,
    options: asked.content.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      detail: choice.detail ?? null
    }))
  })
  return [
    ...open.filter((asked) => asked.context.task !== null).map(question),
    ...open.filter((asked) => asked.context.task === null).map(question),
    ...approvals
      .filter(answeredOnThePhone)
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((approval): MobileAsk => ({
        kind: "approval",
        run_id: approval.run_id,
        tool_id: approval.tool_call_id,
        ...where(approval.destination_session_id),
        asked_at: approval.at,
        title: approvalTitle(approval),
        change: approvalChange(approval)
      }))
  ]
}

const answeredOnThePhone = (approval: RunApproval): boolean =>
  approval.kind !== "integration_connection"

function approvalTitle(approval: RunApproval): string {
  return (
    oneLine(approval.presentation?.title) ??
    oneLine(approval.description) ??
    oneLine(approval.preview) ??
    namedTool({ name: approval.tool_name, displayName: undefined })
  )
}

function approvalChange(approval: RunApproval): MobileChange {
  const files = approval.diff === null ? [] : parseUnifiedDiff(approval.diff)
  if (files.length > 0) return { kind: "diff", files }
  const body = approval.presentation?.body
  if (body?.label === "Command") return { kind: "command", command: body.text }
  const fields = (approval.presentation?.fields ?? [])
    .filter((field) => field.value.trim().length > 0)
    .slice(0, 2)
    .map((field) => `${field.label}: ${field.value}`)
    .join(" · ")
  return {
    kind: "summary",
    text:
      oneLine(approval.preview) ??
      oneLine(approval.description) ??
      oneLine(fields) ??
      approvalTitle(approval)
  }
}

const oneLine = (text: string | null | undefined): string | undefined =>
  previewLine(text ?? null) ?? undefined

type DiffFile = Extract<MobileChange, { readonly kind: "diff" }>["files"][number]

function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: Array<{ file: string; lines: DiffFile["lines"][number][] }> = []
  let label: string | undefined
  let current: (typeof files)[number] | undefined
  let inHunk = false
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("Index: ")) {
      label = line.slice("Index: ".length).trim()
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith("--- ")) continue
    if (!inHunk && line.startsWith("+++ ")) {
      const named = stripDiffPrefix(line.slice(4).split("\t")[0]?.trim() ?? "")
      label = named === "" || named === "/dev/null" ? label : named
      continue
    }
    if (line.startsWith("@@")) {
      inHunk = true
      if (current === undefined || current.file !== (label ?? "")) {
        current = { file: label ?? "", lines: [] }
        files.push(current)
      }
      continue
    }
    if (line.startsWith("diff --git ") || line.startsWith("===")) {
      inHunk = false
      continue
    }
    if (!inHunk || current === undefined) continue
    if (line.startsWith("+")) current.lines.push({ kind: "added", text: line.slice(1) })
    else if (line.startsWith("-")) current.lines.push({ kind: "removed", text: line.slice(1) })
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", text: line.slice(1) })
  }
  return files.filter((file) => file.lines.length > 0)
}

const stripDiffPrefix = (path: string): string => path.replace(/^[ab]\//, "")

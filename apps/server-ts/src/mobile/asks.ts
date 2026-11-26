import { type StoredRunQuestion } from "../persistence/runs/stored-question.js"
import {
  APPROVAL_CARD,
  PRESENTATION_BODY,
  APPROVAL_DIFF,
  APPROVAL_PREVIEW,
  previewLine,
  type ApprovalPresentation
} from "@arden-hq/protocol/chat"
import {
  MOBILE_FILING,
  type MobileAsk,
  type MobileChange,
  type MobileDetail,
  type MobileFiling
} from "@arden-hq/protocol/mobile"
import { APPROVAL_TEXT, type RunApproval, type RunApprovalText } from "@arden-hq/protocol/runs"
import { grantedOnlyInTheApp, type ToolDisplay } from "@arden-hq/protocol/tools"
import { namedTool } from "@arden-hq/protocol/views"

export interface AskPlace {
  readonly name: string | undefined
  readonly spaceId: string | undefined
  readonly home: boolean
  readonly onboarding: boolean
}

export const filingOf = (spaceId: string | null | undefined): MobileFiling =>
  spaceId === undefined || spaceId === null
    ? { kind: MOBILE_FILING.loose }
    : { kind: MOBILE_FILING.space, space_id: spaceId }

const detailOf = (text: string | null | undefined): MobileDetail =>
  text === undefined || text === null ? { kind: "plain" } : { kind: "detailed", text }

export function mobileAsks({
  questions,
  approvals,
  places,
  spaceNames,
  displayOf
}: {
  readonly questions: ReadonlyArray<StoredRunQuestion>
  readonly approvals: ReadonlyArray<RunApproval>
  readonly places: ReadonlyMap<string, AskPlace>
  readonly spaceNames: ReadonlyMap<string, string>
  readonly displayOf: (toolName: string) => ToolDisplay | undefined
}): MobileAsk[] {
  const answeredOnThePhone = (approval: RunApproval): boolean =>
    approval.kind !== "integration_connection" &&
    !grantedOnlyInTheApp(displayOf(approval.tool_name))
  const where = (sessionId: string) => {
    const place = places.get(sessionId)
    const spaceId = place?.spaceId
    const spaceName = spaceId === undefined ? undefined : spaceNames.get(spaceId)
    return {
      session_id: sessionId,
      space: filingOf(spaceId),
      place: (place?.home === true ? spaceName : place?.name?.trim()) || spaceName || "untitled"
    }
  }
  const open = questions.filter(
    (question) =>
      question.status === "open" && places.get(question.destination_session_id)?.onboarding !== true
  )
  const question = (asked: StoredRunQuestion): MobileAsk => ({
    kind: "question",
    question_id: asked.question_id,
    run_id: asked.run_id,
    ...where(asked.destination_session_id),
    asked_at: asked.created_at,
    prompt: asked.content.prompt,
    detail: detailOf(asked.content.detail),
    multiple: asked.content.multiple === true,
    options: asked.content.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      detail: detailOf(choice.detail)
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

const textOf = (text: RunApprovalText): string | undefined =>
  text.kind === APPROVAL_TEXT.text ? text.text : undefined

const previewOf = (approval: RunApproval): string | undefined =>
  approval.preview.kind === APPROVAL_PREVIEW.preview ? approval.preview.text : undefined

const presentationOf = (approval: RunApproval): ApprovalPresentation | undefined =>
  approval.card.kind === APPROVAL_CARD.presented ? approval.card.presentation : undefined

function approvalTitle(approval: RunApproval): string {
  return (
    oneLine(presentationOf(approval)?.title) ??
    oneLine(textOf(approval.description)) ??
    oneLine(previewOf(approval)) ??
    namedTool({ name: approval.tool_name, displayName: null })
  )
}

function approvalChange(approval: RunApproval): MobileChange {
  const files =
    approval.diff.kind === APPROVAL_DIFF.diff ? parseUnifiedDiff(approval.diff.patch) : []
  if (files.length > 0) return { kind: "diff", files }
  const body = presentationOf(approval)?.body
  if (body?.kind === PRESENTATION_BODY.body && body.label === "Command")
    return { kind: "command", command: body.text }
  const fields = (presentationOf(approval)?.fields ?? [])
    .filter((field) => field.value.trim().length > 0)
    .slice(0, 2)
    .map((field) => `${field.label}: ${field.value}`)
    .join(" · ")
  return {
    kind: "summary",
    text:
      oneLine(previewOf(approval)) ??
      oneLine(textOf(approval.description)) ??
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

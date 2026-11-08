import type { SessionExportFormat, SessionExportResponse } from "@arden-hq/protocol/sessions"
import { DateTime, Effect, Predicate } from "effect"
import type { ActiveSessionSnapshot } from "../persistence/sessions/model.js"
import type {
  StoredMessageEnvelope,
  TranscriptMessageRecord
} from "../persistence/transcript/model.js"
import { TranscriptQueryError, type TranscriptQueries } from "../persistence/transcript/queries.js"
import { sha256Hex } from "@arden-hq/std/hash"

const TRANSCRIPT_PAGE_SIZE = 250

const EXCLUDED = [
  "Arden credential vaults, provider and OAuth tokens, API settings, and other app-wide state are excluded.",
  "External attachment, artifact, URL, and source bytes are not copied unless they are embedded in a message envelope.",
  "Run events, approvals, todos, focus, wiki pages, Space records, and automation definitions are outside this Session export."
] as const

const NORMALIZATION = [
  "Stored JSON is parsed and pretty-printed, so whitespace and object key order are normalized.",
  "The active Session snapshot and immutable transcript are canonical reads; an actively changing Chat can advance after the export boundary."
] as const

const SESSION_EXPORT_WARNINGS = [
  ...EXCLUDED,
  ...NORMALIZATION,
  "Session metadata and message envelopes are included verbatim and can contain user-authored secrets."
] as const

interface SessionExportRecord {
  readonly session_id: string
  readonly message_id: string
  readonly sequence: number
  readonly role: TranscriptMessageRecord["role"]
  readonly client_id: string | null
  readonly created_at: string
  readonly envelope: StoredMessageEnvelope
}

interface SessionExportSnapshot {
  readonly session_id: string
  readonly public_ref: string
  readonly started_at: string
  readonly last_activity: string
  readonly name: string | null
  readonly session_type: ActiveSessionSnapshot["header"]["sessionType"]
  readonly origin_automation_id: string | null
  readonly parent_session_id: string | null
  readonly parent_run_id: string | null
  readonly parent_tool_call_id: string | null
  readonly parent_message_id: string | null
  readonly space_id: string | null
  readonly chat_model: string | null
  readonly active_message_count: number
  readonly last_input_tokens: number | null
  readonly context_generation: number
  readonly context_etag: string
  readonly metadata: ActiveSessionSnapshot["metadata"]
  readonly active_projection: ReadonlyArray<StoredMessageEnvelope>
}

export interface SessionExportModel {
  readonly exportedAt: string
  readonly session: SessionExportSnapshot
  readonly throughSequence: number | null
  readonly records: ReadonlyArray<SessionExportRecord>
}

const coverage = (throughSequence: number | null) => ({
  credential_material: "excluded" as const,
  external_bytes: "embedded_only" as const,
  message_envelopes: "complete" as const,
  included: [
    "The complete parsed Session header, metadata, lineage, context fence, and active message projection.",
    `Every durable transcript record through sequence ${throughSequence ?? "none"}, with stable ids, timestamps, and full message envelopes.`,
    "Envelope fields include embedded images, attachment and context blocks, tool calls and results, artifact metadata, and source refs when present."
  ],
  excluded: [...EXCLUDED],
  normalization: [...NORMALIZATION]
})

export const readSessionExportTranscript = Effect.fn("SessionExport.readTranscript")(function* (
  transcript: TranscriptQueries["Service"],
  sessionId: string
) {
  const latest = yield* transcript.page({
    _tag: "Latest",
    sessionId,
    limit: 1
  })
  const throughSequence = latest.lastSequence
  if (throughSequence === null) return []

  const records: Array<TranscriptMessageRecord> = []
  let afterSequence = -1
  while (afterSequence < throughSequence) {
    const page = yield* transcript.page({
      _tag: "After",
      sessionId,
      sequence: afterSequence,
      limit: TRANSCRIPT_PAGE_SIZE
    })
    const bounded = page.records.filter((record) => record.sequence <= throughSequence)
    records.push(...bounded)
    const lastSequence = bounded[bounded.length - 1]?.sequence
    if (lastSequence === undefined) {
      return yield* new TranscriptQueryError({
        operation: "page",
        sessionId,
        message: `Transcript changed before export reached sequence ${throughSequence}`
      })
    }
    if (lastSequence >= throughSequence) break
    afterSequence = lastSequence
  }
  return records
})

export const makeSessionExportModel = (
  snapshot: ActiveSessionSnapshot,
  records: ReadonlyArray<TranscriptMessageRecord>,
  exportedAt: string
): SessionExportModel => ({
  exportedAt,
  session: {
    session_id: snapshot.header.sessionId,
    public_ref: snapshot.header.publicRef,
    started_at: DateTime.formatIso(snapshot.header.startedAt),
    last_activity: DateTime.formatIso(snapshot.header.lastActivity),
    name: snapshot.header.name,
    session_type: snapshot.header.sessionType,
    origin_automation_id: snapshot.header.originAutomationId,
    parent_session_id: snapshot.header.parentSessionId,
    parent_run_id: snapshot.header.parentRunId,
    parent_tool_call_id: snapshot.header.parentToolCallId,
    parent_message_id: snapshot.header.parentMessageId,
    space_id: snapshot.header.spaceId,
    chat_model: snapshot.header.chatModel,
    active_message_count: snapshot.header.activeMessageCount,
    last_input_tokens: snapshot.header.lastInputTokens,
    context_generation: snapshot.header.contextGeneration,
    context_etag: sha256Hex(JSON.stringify(snapshot.messages)),
    metadata: snapshot.metadata,
    active_projection: snapshot.messages
  },
  throughSequence: records[records.length - 1]?.sequence ?? null,
  records: records.map((record) => ({
    session_id: record.sessionId,
    message_id: record.messageId,
    sequence: record.sequence,
    role: record.role,
    client_id: record.clientId,
    created_at: DateTime.formatIso(record.createdAt),
    envelope: record.envelope
  }))
})

export const renderSessionExport = (
  model: SessionExportModel,
  format: SessionExportFormat
): SessionExportResponse => {
  const filenameBase = safeFilenameBase(model.session.name ?? model.session.public_ref)
  const warnings = [...SESSION_EXPORT_WARNINGS]
  switch (format) {
    case "archive":
      return {
        format,
        filename: `${filenameBase}.arden.json`,
        media_type: "application/vnd.arden.session+json",
        content: `${JSON.stringify(archiveDocument(model), null, 2)}\n`,
        warnings
      }
    case "json":
      return {
        format,
        filename: `${filenameBase}.json`,
        media_type: "application/json",
        content: `${JSON.stringify(readableDocument(model), null, 2)}\n`,
        warnings
      }
    case "jsonl":
      return {
        format,
        filename: `${filenameBase}.jsonl`,
        media_type: "application/x-ndjson",
        content: renderJsonl(model),
        warnings
      }
    case "markdown":
      return {
        format,
        filename: `${filenameBase}.md`,
        media_type: "text/markdown",
        content: renderMarkdown(model),
        warnings
      }
  }
}

const archiveDocument = (model: SessionExportModel) => ({
  format: "arden.session.archive",
  version: 1,
  exported_at: model.exportedAt,
  coverage: coverage(model.throughSequence),
  snapshot: model.session,
  transcript: {
    through_sequence: model.throughSequence,
    records: model.records
  }
})

const readableDocument = (model: SessionExportModel) => ({
  format: "arden.session.transcript",
  version: 1,
  exported_at: model.exportedAt,
  coverage: coverage(model.throughSequence),
  session: model.session,
  messages: model.records
})

const renderJsonl = (model: SessionExportModel): string =>
  `${[
    JSON.stringify({
      type: "header",
      format: "arden.session.jsonl",
      version: 1,
      exported_at: model.exportedAt,
      coverage: coverage(model.throughSequence),
      through_sequence: model.throughSequence,
      snapshot: model.session
    }),
    ...model.records.map((record) => JSON.stringify({ type: "message", ...record }))
  ].join("\n")}\n`

const renderMarkdown = (model: SessionExportModel): string => {
  const sections = [
    "# Arden Session Export",
    "",
    `Exported at ${model.exportedAt}.`,
    "",
    "## Coverage",
    "",
    ...coverageLines(model),
    "",
    "## Session snapshot",
    "",
    jsonCodeBlock(model.session),
    "",
    "## Messages",
    ""
  ]

  if (model.records.length === 0) sections.push("_No durable transcript messages._", "")
  for (const record of model.records) {
    sections.push(
      `### Message ${record.sequence} · ${record.role}`,
      "",
      `- Message ID: ${JSON.stringify(record.message_id)}`,
      `- Client ID: ${JSON.stringify(record.client_id)}`,
      `- Created: ${record.created_at}`,
      "",
      renderDisplayContent(record.envelope.content),
      "",
      "<details>",
      "<summary>Canonical message envelope</summary>",
      "",
      jsonCodeBlock(record.envelope),
      "",
      "</details>",
      ""
    )
  }
  return `${sections.join("\n").trimEnd()}\n`
}

const coverageLines = (model: SessionExportModel): ReadonlyArray<string> => {
  const details = coverage(model.throughSequence)
  return [
    "Included:",
    ...details.included.map((item) => `- ${item}`),
    "",
    "Excluded or normalized:",
    ...details.excluded.map((item) => `- ${item}`),
    ...details.normalization.map((item) => `- ${item}`),
    `- ${SESSION_EXPORT_WARNINGS[SESSION_EXPORT_WARNINGS.length - 1]}`
  ]
}

const renderDisplayContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content.length === 0 ? "_No display text._" : markdownDisplayText(content)
  }
  if (!Array.isArray(content)) {
    return content === undefined ? "_No display content._" : jsonCodeBlock(content)
  }

  const rendered = content.flatMap((block) => {
    if (!Predicate.isObject(block)) {
      return ["_Structured content block; full data is in the canonical envelope below._"]
    }
    const value = block
    if (value.type === "text" && typeof value.text === "string") {
      return [markdownDisplayText(value.text)]
    }
    if (value.type === "image") {
      const mediaType = typeof value.media_type === "string" ? value.media_type : "unknown type"
      const bytes = typeof value.data === "string" ? value.data.length : 0
      return [`_Embedded image (${mediaType}; ${bytes} encoded characters). Full data is below._`]
    }
    const kind = typeof value.type === "string" ? value.type : "structured"
    return [`_${kind} content block; full data is in the canonical envelope below._`]
  })
  return rendered.length === 0 ? "_No display content._" : rendered.join("\n\n")
}

const markdownDisplayText = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("`", "\\`")

const jsonCodeBlock = (value: unknown): string => {
  const json = JSON.stringify(value, null, 2) ?? "null"
  const longest = Math.max(2, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length))
  const fence = "`".repeat(longest + 1)
  return `${fence}json\n${json}\n${fence}`
}

const safeFilenameBase = (value: string): string => {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"])
  const normalized = Array.from(value.normalize("NFKC"), (character) =>
    character.charCodeAt(0) < 32 || forbidden.has(character) ? "-" : character
  ).join("")
  const compact = normalized
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
  const bounded = Array.from(compact).slice(0, 80).join("") || "arden-session"
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(bounded) ? `arden-${bounded}` : bounded
}

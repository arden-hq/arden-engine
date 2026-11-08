import type { DatabaseSync } from "node:sqlite"
import type { Migration } from "./index.js"

interface FileRow {
  readonly attachment_id: number
  readonly name: string
}

const RESULT_SUMMARY_MAX = 500

const escapeLabel = (text: string): string => text.replace(/[\\[\]]/g, "\\$&")

const fileHref = (itemId: string, attachmentId: number): string =>
  `arden:task/${encodeURIComponent(itemId)}/file/${attachmentId}`

const rewriteTaskReportLinks = (
  itemId: string,
  text: string,
  files: ReadonlyArray<FileRow>
): string => {
  const selfHref = `arden:work/${encodeURIComponent(itemId)}`
  if (!text.includes(`](${selfHref})`)) return text
  const fileNamed = (label: string): FileRow | undefined =>
    files.findLast((file) => label.endsWith(` — ${file.name}`))
  const heading = `[Result evidence](${selfHref}):\n`
  const start = text.indexOf(heading)
  let report: FileRow | undefined
  let rewritten = text
  if (start >= 0) {
    const bodyStart = start + heading.length
    const lines = text.slice(bodyStart).split("\n")
    const listed = lines.findIndex((line) => !line.startsWith("- "))
    const items = listed === -1 ? lines : lines.slice(0, listed)
    const linked: Array<string> = []
    for (const line of items) {
      const label = line.slice(2)
      const file = fileNamed(label)
      if (file === undefined) {
        linked.push(line)
        continue
      }
      report ??= file
      linked.push(`- [${escapeLabel(label)}](${fileHref(itemId, file.attachment_id)})`)
    }
    rewritten = [
      text.slice(0, start),
      "Result evidence:\n",
      [...linked, ...(listed === -1 ? [] : lines.slice(listed))].join("\n")
    ].join("")
  }
  if (report === undefined) return rewritten
  return rewritten.split(`](${selfHref})`).join(`](${fileHref(itemId, report.attachment_id)})`)
}

export const taskReportLinks: Migration = {
  version: 6,
  name: "task_report_links",
  foreignKeys: { kind: "enforced" },
  up: (database: DatabaseSync) => {
    const results = database
      .prepare(
        `SELECT event_id, item_id, summary, result_summary FROM desk_task_events
         WHERE content_kind = 'result' AND item_id IS NOT NULL AND summary LIKE '%](arden:work/%'`
      )
      .all()
      .map((row) => ({
        event_id: Number(row.event_id),
        item_id: String(row.item_id),
        summary: String(row.summary),
        result_summary: row.result_summary === null ? null : String(row.result_summary)
      }))
    const filesOf = database.prepare(
      "SELECT attachment_id, name FROM desk_task_attachments WHERE item_id = ? ORDER BY attachment_id"
    )
    const update = database.prepare(
      "UPDATE desk_task_events SET summary = ?, result_summary = ? WHERE event_id = ?"
    )
    for (const row of results) {
      const files = filesOf.all(row.item_id).map((file) => ({
        attachment_id: Number(file.attachment_id),
        name: String(file.name)
      }))
      if (files.length === 0) continue
      const summary = rewriteTaskReportLinks(row.item_id, row.summary, files)
      if (summary === row.summary) continue
      const reportHref = /\]\((arden:task\/[^)]+\/file\/\d+)\)/.exec(summary)?.[1]
      const selfLink = `](arden:work/${encodeURIComponent(row.item_id)})`
      const sentence =
        row.result_summary !== null && reportHref !== undefined
          ? row.result_summary.split(selfLink).join(`](${reportHref})`)
          : row.result_summary
      update.run(
        summary,
        sentence !== null && sentence.trim().length <= RESULT_SUMMARY_MAX
          ? sentence
          : row.result_summary,
        row.event_id
      )
    }
  }
}

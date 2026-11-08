import type { Migration } from "./index.js"

const requestInvalid = (code: string | null, message: string): boolean =>
  code === "request_invalid" ||
  ((code === "provider_error" || code === null) &&
    [
      /request failed with status 400\b[\s\S]*"type"\s*:\s*"invalid_request_error"/,
      /^Stored (?:OpenAI|provider) (?:tool|response) history /,
      /refused the run \(HTTP 400\): (?:Invalid Value: 'tools'|Async tools are not supported|.*reserved namespace)/
    ].some((pattern) => pattern.test(message.trim())))

export const taskStopCause: Migration = {
  version: 49,
  name: "task_stop_cause",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`ALTER TABLE desk_task_events ADD COLUMN stop_cause TEXT
      CHECK(stop_cause IN ('request_invalid', 'run_interrupted', 'provider_unavailable', 'rate_limited', 'stalled', 'failed'))`)
    const rows = database
      .prepare(
        `SELECT event.event_id, event.event_type, event.summary,
        run.error_code, run.error_message
      FROM desk_task_events AS event LEFT JOIN chat_runs AS run ON run.run_id = event.run_ref
      WHERE event.event_type IN ('failed', 'retry_scheduled', 'stalled', 'blocked')`
      )
      .all()
    const update = database.prepare(
      "UPDATE desk_task_events SET stop_cause = ?, summary = ? WHERE event_id = ?"
    )
    for (const row of rows) {
      if (typeof row.event_id !== "number" || typeof row.summary !== "string")
        throw new Error("Task event cannot be converted to a typed stop cause")
      const previousSummary = row.summary
      const code = typeof row.error_code === "string" ? row.error_code : null
      const error = typeof row.error_message === "string" ? row.error_message : ""
      const invalidSummary = requestInvalid(null, previousSummary)
      const cause = () => {
        if (previousSummary.startsWith("A restart cut the run off")) return "run_interrupted"
        if (row.event_type === "stalled") return "stalled"
        if (
          requestInvalid(code, error) ||
          invalidSummary ||
          previousSummary.startsWith("Arden couldn't send this Task's work to the model.")
        )
          return "request_invalid"
        if (previousSummary.startsWith("Couldn't reach the model provider"))
          return "provider_unavailable"
        if (previousSummary.startsWith("The model provider asked Arden to slow down"))
          return "rate_limited"
        return "failed"
      }
      const legacyFailureText =
        /image you provided requires \d+ patches|resize the image and try again/i.test(
          previousSummary
        )
          ? "An image was too large to send. Arden now shrinks it — try again."
          : "Arden couldn't send this to the model. Try again — if it keeps happening, send a report."
      const summary = invalidSummary ? legacyFailureText : previousSummary
      update.run(cause(), summary, row.event_id)
    }
  }
}

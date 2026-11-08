import type { ApprovalEditLine, ServerApprovalEdits } from "./approval-edits.js"

export const SEND_EDITABLE_FIELDS = ["subject", "body", "omit_attachments"] as const

export const REPLY_EDITABLE_FIELDS = ["body", "omit_attachments"] as const

interface MailWords {
  readonly subject?: string
  readonly body: string
  readonly omit_attachments?: ReadonlyArray<number>
}

const inQuotes = (text: string): string => `"${text}"`

export const mailEditLines = (
  requested: MailWords,
  edited: MailWords
): ReadonlyArray<ApprovalEditLine> => {
  const lines: Array<ApprovalEditLine> = []
  if (
    requested.subject !== undefined &&
    edited.subject !== undefined &&
    requested.subject !== edited.subject
  ) {
    lines.push({
      field: "subject",
      label: "Subject",
      from: inQuotes(requested.subject),
      to: inQuotes(edited.subject)
    })
  }
  if (requested.body !== edited.body) {
    lines.push({
      field: "body",
      label: "Message",
      from: inQuotes(requested.body),
      to: inQuotes(edited.body)
    })
  }
  if (
    JSON.stringify(requested.omit_attachments ?? []) !==
    JSON.stringify(edited.omit_attachments ?? [])
  ) {
    lines.push({
      field: "omit_attachments",
      label: "Omitted attachments",
      from:
        (requested.omit_attachments ?? []).map((index) => String(index + 1)).join(", ") || "None",
      to: (edited.omit_attachments ?? []).map((index) => String(index + 1)).join(", ") || "None"
    })
  }
  return lines
}

export const bodyProblem = (input: { readonly body: string }): string | undefined =>
  input.body.trim() === "" ? "An email needs words in its body." : undefined

const sendProblem = (input: { readonly subject: string; readonly body: string }) =>
  (/[\r\n]/u.test(input.subject) ? "Email subjects cannot contain line breaks." : undefined) ??
  bodyProblem(input)

export const SEND_APPROVAL_EDITS: ServerApprovalEdits<MailWords & { readonly subject: string }> = {
  fields: SEND_EDITABLE_FIELDS,
  check: sendProblem,
  describe: mailEditLines
}

export const REPLY_APPROVAL_EDITS: ServerApprovalEdits<MailWords> = {
  fields: REPLY_EDITABLE_FIELDS,
  check: bodyProblem,
  describe: mailEditLines
}

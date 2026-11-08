import { gmailThreadUrl } from "@arden-hq/protocol/google"
import { passage, unquotedEmail } from "./source-passage.js"

export const emailSource = (
  input: {
    readonly kind: "message" | "thread"
    readonly ref: string
    readonly account: string
    readonly threadId: string
    readonly subject: string
    readonly from: string
    readonly receivedAt: string | null
  } & ({ readonly use: "read"; readonly body: string } | { readonly use: "found" })
) => {
  const excerpt = input.use === "read" ? passage(unquotedEmail(input.body)) : undefined
  const by = input.from
    .replace(/\s*<[^>]*>\s*$/, "")
    .replace(/^"|"$/g, "")
    .trim()
  return {
    provider: "gmail",
    kind: input.kind,
    ref: input.ref,
    title: input.subject,
    use: input.use,
    href: gmailThreadUrl(input.account, input.threadId),
    ...(by.length === 0 ? {} : { by }),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(input.receivedAt === null ? {} : { at: input.receivedAt })
  }
}

import type { ServerTool } from "./define.js"
import { connectedAccountEmails, type GoogleToolConnections } from "./google-accounts.js"
import { gmailAttachmentTool } from "./google-gmail-attachment.js"
import { gmailDraftTool, saveCardDraft } from "./google-gmail-draft.js"
import { gmailForwardTool } from "./google-gmail-forward.js"
import { gmailModifyTools } from "./google-gmail-modify.js"
import { gmailReadTools } from "./google-gmail-read.js"
import { gmailSendTools } from "./google-gmail-send.js"
import { gmailUnsubscribeTool } from "./google-gmail-unsubscribe.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import type { SharedFileAccess } from "./shared-files.js"

export const makeGmailTools = ({
  google,
  paths,
  files
}: {
  readonly google: GoogleToolConnections
  readonly files: SharedFileAccess
  readonly paths: LocalPathServices
}): ReadonlyArray<ServerTool> => {
  const emails = connectedAccountEmails(google, "gmail")
  return [
    ...gmailReadTools({ google, emails }),
    gmailAttachmentTool({ google, emails, paths, files }),
    ...gmailSendTools({
      google,
      emails,
      files,
      saveDraft: (request) => saveCardDraft({ google, ...request })
    }),
    gmailForwardTool({ google, emails, files }),
    gmailDraftTool({ google, emails, files }),
    ...gmailModifyTools({ google, emails }),
    gmailUnsubscribeTool({ google, emails })
  ]
}

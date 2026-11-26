import { Schema } from "effect"
import { RunApprovalWorkSchema } from "../runs/context.js"
import { ApprovalPresentationSchema } from "./approval-presentation.js"
import {
  APPROVAL_ASKED,
  APPROVAL_ASKER,
  APPROVAL_CARD,
  APPROVAL_DIFF,
  APPROVAL_GRANT_FOLDER,
  APPROVAL_PREVIEW,
  CONNECTION_ACCOUNT
} from "./runtime.js"

export const ApprovalGrantFolderSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_GRANT_FOLDER.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_GRANT_FOLDER.folder), folder: Schema.String })
])

export const ApprovalAskerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKER.chat) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKER.work), work: RunApprovalWorkSchema })
])

export const ApprovalPreviewSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_PREVIEW.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_PREVIEW.preview), text: Schema.String })
])

export const ApprovalDiffSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_DIFF.none) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_DIFF.diff), patch: Schema.String })
])

export const ApprovalCardSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_CARD.plain) }),
  Schema.Struct({
    kind: Schema.Literal(APPROVAL_CARD.presented),
    presentation: ApprovalPresentationSchema
  })
])

export const ConnectionAccountSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(CONNECTION_ACCOUNT.default) }),
  Schema.Struct({ kind: Schema.Literal(CONNECTION_ACCOUNT.account), ref: Schema.String })
])

export const ApprovalAskedSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKED.unrecorded) }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_ASKED.recorded), at: Schema.String })
])

import { Schema } from "effect"

const Id = Schema.NonEmptyString

export const APPROVAL_SOURCE = {
  chat: "chat",
  space_thread: "space_thread",
  automation: "automation",
  stricter: "stricter"
} as const

const SingleApprovalSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal(APPROVAL_SOURCE.chat), session_id: Id }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_SOURCE.space_thread), space_id: Id }),
  Schema.Struct({ kind: Schema.Literal(APPROVAL_SOURCE.automation), automation_id: Id })
])
export type SingleApprovalSource = typeof SingleApprovalSourceSchema.Type

export const ApprovalSourceSchema = Schema.Union([
  ...SingleApprovalSourceSchema.members,
  Schema.Struct({
    kind: Schema.Literal(APPROVAL_SOURCE.stricter),
    of: Schema.Array(SingleApprovalSourceSchema).check(Schema.isMinLength(2))
  })
])
export type ApprovalSource = typeof ApprovalSourceSchema.Type

export const approvalSources = (source: ApprovalSource): ReadonlyArray<SingleApprovalSource> =>
  source.kind === APPROVAL_SOURCE.stricter ? source.of : [source]

export const sameSource = (left: SingleApprovalSource, right: SingleApprovalSource): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export const stricterSource = (left: ApprovalSource, right: ApprovalSource): ApprovalSource => {
  const of = [...approvalSources(left)]
  for (const source of approvalSources(right))
    if (!of.some((held) => sameSource(held, source))) of.push(source)
  const [only] = of
  return of.length === 1 && only !== undefined ? only : { kind: APPROVAL_SOURCE.stricter, of }
}

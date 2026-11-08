import { LOCAL_FOLDER_LIMITS } from "@arden-hq/protocol/spaces"
import { Schema } from "effect"

const LocalFolderSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(LOCAL_FOLDER_LIMITS.length)
)

const SpaceFolderGrantSchema = Schema.Struct({
  _tag: Schema.Literal("SpaceFolderGrant"),
  space_id: Schema.NonEmptyString,
  local_folder: LocalFolderSchema
})

const SpaceFolderApprovalDataSchema = Schema.Struct({
  sandbox_root: Schema.NonEmptyString,
  working_directory: Schema.NonEmptyString,
  space_folder_grant: SpaceFolderGrantSchema
}).check(
  Schema.makeFilter((data) =>
    data.space_folder_grant.local_folder === data.sandbox_root
      ? undefined
      : {
          path: ["space_folder_grant", "local_folder"],
          issue: "must match sandbox_root"
        }
  )
)

export type SpaceFolderApprovalData = (typeof SpaceFolderApprovalDataSchema)["Type"]

const isSpaceFolderApprovalData = Schema.is(SpaceFolderApprovalDataSchema)
const carriesSpaceFolderGrant = Schema.is(
  Schema.Struct({ space_folder_grant: SpaceFolderGrantSchema })
)

const OUTSIDE_FILE_TOOLS: ReadonlySet<string> = new Set([
  "browser_upload",
  "file_write",
  "file_edit"
])

export const spaceFolderGrantOf = (
  toolName: string,
  data: unknown
): SpaceFolderApprovalData["space_folder_grant"] | undefined => {
  if (toolName === "spawn_agent")
    return isSpaceFolderApprovalData(data) ? data.space_folder_grant : undefined
  if (OUTSIDE_FILE_TOOLS.has(toolName))
    return carriesSpaceFolderGrant(data) ? data.space_folder_grant : undefined
  return undefined
}

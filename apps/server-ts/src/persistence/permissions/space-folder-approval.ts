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

const FOLDER_GRANT_TOOL = {
  spawnAgent: "spawn_agent",
  browserUpload: "browser_upload",
  fileWrite: "file_write",
  fileEdit: "file_edit"
} as const
type FolderGrantTool = (typeof FOLDER_GRANT_TOOL)[keyof typeof FOLDER_GRANT_TOOL]

const OUTSIDE_FILE_TOOLS: ReadonlySet<string> = new Set<FolderGrantTool>([
  FOLDER_GRANT_TOOL.browserUpload,
  FOLDER_GRANT_TOOL.fileWrite,
  FOLDER_GRANT_TOOL.fileEdit
])

export const spaceFolderGrantOf = (
  toolName: string,
  data: unknown
): SpaceFolderApprovalData["space_folder_grant"] | undefined => {
  if (toolName === FOLDER_GRANT_TOOL.spawnAgent)
    return isSpaceFolderApprovalData(data) ? data.space_folder_grant : undefined
  if (OUTSIDE_FILE_TOOLS.has(toolName))
    return carriesSpaceFolderGrant(data) ? data.space_folder_grant : undefined
  return undefined
}

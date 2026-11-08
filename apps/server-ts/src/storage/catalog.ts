import type { StorageCategoryId } from "@arden-hq/protocol/storage"

export type StorageRootBucket = "database" | Exclude<StorageCategoryId, "channels">

export type StorageRootEntry =
  | {
      readonly kind: "known"
      readonly authority:
        | "operational_sqlite"
        | "wiki_revisions"
        | "conversation_artifacts"
        | "managed_outputs"
        | "chat_uploads"
        | "search_index"
        | "research_workspace"
        | "installed_skills"
        | "configuration"
        | "diagnostics"
      readonly bucket: StorageRootBucket
      readonly backup: "required" | "sqlite_snapshot" | "separate" | "optional" | "excluded"
      readonly rebuildability: "authoritative" | "rebuildable" | "diagnostic"
      readonly lifecycle: string
    }
  | {
      readonly kind: "unknown"
      readonly bucket: "other"
    }

const rootEntries = {
  memory: {
    kind: "known",
    authority: "wiki_revisions",
    bucket: "knowledge",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Wiki pages and history. Managed in Knowledge."
  },
  skills: {
    kind: "known",
    authority: "installed_skills",
    bucket: "skills",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Installed skills. Managed in Skills."
  },
  conversations: {
    kind: "known",
    authority: "conversation_artifacts",
    bucket: "chats",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Chat artifacts. Removed with their Chat."
  },
  "managed-outputs": {
    kind: "known",
    authority: "managed_outputs",
    bucket: "chats",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Durable tool outputs. Removed only after their owning Session references are gone."
  },
  uploads: {
    kind: "known",
    authority: "chat_uploads",
    bucket: "chats",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle:
      "Copies of files attached from Downloads, the Trash or a temporary folder, so their chats can still read them. Removed when no remaining Chat names them; a copy never sent goes a day after it was attached."
  },
  "search.sqlite": {
    kind: "known",
    authority: "search_index",
    bucket: "housekeeping",
    backup: "excluded",
    rebuildability: "rebuildable",
    lifecycle:
      "Derived transcript and Wiki search. Rebuilt from operational records and Wiki revisions."
  },
  research: {
    kind: "known",
    authority: "research_workspace",
    bucket: "agents",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Research workspaces that agents refer to."
  },
  logs: {
    kind: "known",
    authority: "diagnostics",
    bucket: "housekeeping",
    backup: "optional",
    rebuildability: "diagnostic",
    lifecycle: "Service logs. Rotated diagnostics, not operational history."
  },
  "AGENTS.md": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Global instructions for every chat."
  },
  "directives.json": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "optional",
    rebuildability: "diagnostic",
    lifecycle: "Old copy of the global instructions, kept after they moved to AGENTS.md."
  },
  "bash-permissions.json": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Saved command permissions."
  },
  "google-oauth-client.json": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "separate",
    rebuildability: "authoritative",
    lifecycle: "Connection configuration. Restore separately from exports."
  },
  "ui-settings.json": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "App preferences."
  },
  "models.json": {
    kind: "known",
    authority: "configuration",
    bucket: "housekeeping",
    backup: "required",
    rebuildability: "authoritative",
    lifecycle: "Model configuration."
  }
} as const satisfies Record<string, StorageRootEntry>

export const classifyStorageRootEntry = (
  name: string,
  databaseName: string | null
): StorageRootEntry => {
  if (
    databaseName !== null &&
    (name === databaseName || name === `${databaseName}-wal` || name === `${databaseName}-shm`)
  ) {
    return {
      kind: "known",
      authority: "operational_sqlite",
      bucket: "database",
      backup: "sqlite_snapshot",
      rebuildability: "authoritative",
      lifecycle: "Active database and companion files. Never delete while Arden runs."
    }
  }
  const catalogName =
    name === "search.sqlite-wal" || name === "search.sqlite-shm" ? "search.sqlite" : name
  if (Object.hasOwn(rootEntries, catalogName))
    return rootEntries[catalogName as keyof typeof rootEntries]
  return { kind: "unknown", bucket: "other" }
}

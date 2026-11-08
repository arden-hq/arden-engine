interface SchemaSection {
  readonly name: string
  readonly tables: ReadonlyArray<string>
  readonly indexes: ReadonlyArray<string>
  readonly triggers: ReadonlyArray<string>
  readonly statements: ReadonlyArray<string>
}

type StorageDomain =
  | "conversation"
  | "execution"
  | "model_context"
  | "journal"
  | "work"
  | "automation"
  | "workflow"
  | "configuration"
  | "operations"
  | "payload_lifecycle"
  | "search_sync"

export interface OperationalSchemaSection extends SchemaSection {
  readonly storageDomain: StorageDomain
}

export interface VersionedSchemaSection extends SchemaSection {
  readonly version: number
}

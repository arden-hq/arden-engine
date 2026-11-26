import { type McpServer as PublicMcpServer } from "@arden-hq/protocol/mcp"
import type { McpStoredServer } from "../persistence/mcp/store.js"
import { type McpToolBinding } from "./catalog.js"
import { type McpOperation } from "./errors.js"
import {
  type RuntimeStatus,
  type RuntimeEntry,
  type McpLiveEvents,
  type ConnectOptions
} from "./runtime.js"

export interface McpRuntime {
  readonly get: (name: string) => RuntimeEntry | undefined
  readonly liveEvents: (name: string) => McpLiveEvents | undefined
  readonly has: (name: string) => boolean
  readonly names: () => ReadonlyArray<string>
  readonly requireRuntime: (name: string, operation: McpOperation) => RuntimeEntry
  readonly boundToolNames: () => Map<string, string>
  readonly snapshotOne: (entry: RuntimeEntry) => PublicMcpServer
  readonly snapshot: () => ReadonlyArray<PublicMcpServer>
  readonly bindings: () => ReadonlyArray<McpToolBinding>
  readonly runBindings: () => ReadonlyArray<McpToolBinding>
  readonly reset: (config: McpStoredServer, status: RuntimeStatus) => RuntimeEntry
  readonly onConnected: (listener: (config: McpStoredServer) => void) => () => void
  readonly onChanged: (listener: (name: string) => void) => () => void
  readonly start: (config: McpStoredServer) => RuntimeEntry
  readonly forget: (name: string) => void
  readonly interruptConnection: (name: string) => void
  readonly replaceCredentialIdentity: (
    config: McpStoredServer,
    operation: McpOperation
  ) => Promise<void>
  readonly clearOAuth: (config: McpStoredServer) => Promise<void>
  readonly refreshAccountIdentity: (config: McpStoredServer) => Promise<void>
  readonly connectNow: (config: McpStoredServer, input?: ConnectOptions) => Promise<RuntimeEntry>
  readonly connect: (config: McpStoredServer, options?: ConnectOptions) => Promise<RuntimeEntry>
  readonly reconnectPresetSiblings: (source: McpStoredServer) => void
  readonly shutdown: () => Promise<void>
}

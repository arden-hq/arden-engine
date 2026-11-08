import type { CommandKind } from "@arden-hq/relay-protocol"
import { Context, type Effect, Schema } from "effect"
import { storeErrorFields } from "../errors.js"
import type { Notice } from "../sqlite/notices.js"

export class RelayStoreError extends Schema.TaggedError<RelayStoreError>()("RelayStoreError", {
  ...storeErrorFields({
    operations: [
      "devices",
      "device_write",
      "commands",
      "settings",
      "update_settings",
      "runs",
      "push"
    ],
    reasons: ["invalid", "storage"]
  })
}) {}

export interface PairedDevice {
  readonly dev: string
  readonly name: string
  readonly edPub: string
  readonly xPub: string
  readonly addedAt: string
  readonly lastSeenAt: string | undefined
  readonly push: PushTarget | undefined
}

export interface PushTarget {
  readonly token: string
  readonly env: "sandbox" | "production"
  readonly topic: string
}

export type RelayCommandState = "running" | "done" | "stopping" | "rejected"

export interface RelayCommandRecord {
  readonly cid: string
  readonly kind: CommandKind
  readonly state: RelayCommandState
  readonly result: Schema.Json | undefined
  readonly createdAt: string
}

export const RelaySettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  relayUrl: Schema.String.check(Schema.isPattern(/^wss?:\/\/[^\s]+$/)),
  keepAwake: Schema.Boolean
})
export type RelaySettings = typeof RelaySettingsSchema.Type

export const RelaySettingsPatchSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  relayUrl: Schema.optionalKey(RelaySettingsSchema.fields.relayUrl),
  keepAwake: Schema.optionalKey(Schema.Boolean)
})
export type RelaySettingsPatch = typeof RelaySettingsPatchSchema.Type

const RELAY_URLS = {
  hosted: "wss://relay.fromarden.com",
  local: "ws://127.0.0.1:8787"
} as const

export const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  enabled: true,
  relayUrl: RELAY_URLS.hosted,
  keepAwake: true
}

export class RelayStore extends Context.Service<
  RelayStore,
  {
    readonly devices: () => Effect.Effect<ReadonlyArray<PairedDevice>, RelayStoreError>
    readonly device: (dev: string) => Effect.Effect<PairedDevice | undefined, RelayStoreError>
    readonly addDevice: (
      device: Omit<PairedDevice, "addedAt" | "lastSeenAt" | "push">
    ) => Effect.Effect<PairedDevice, RelayStoreError>
    readonly revokeDevice: (dev: string) => Effect.Effect<boolean, RelayStoreError>
    readonly touchDevice: (dev: string, at: string) => Effect.Effect<void, RelayStoreError>
    readonly setPush: (
      dev: string,
      push: PushTarget | undefined
    ) => Effect.Effect<void, RelayStoreError>
    readonly personPresent: () => Effect.Effect<boolean, RelayStoreError>
    readonly command: (
      cid: string
    ) => Effect.Effect<RelayCommandRecord | undefined, RelayStoreError>
    readonly beginCommand: (input: {
      readonly cid: string
      readonly kind: CommandKind
    }) => Effect.Effect<RelayCommandRecord | undefined, RelayStoreError>
    readonly finishCommand: (input: {
      readonly cid: string
      readonly state: Exclude<RelayCommandState, "running">
      readonly result: Schema.Json | undefined
    }) => Effect.Effect<void, RelayStoreError>
    readonly pruneCommands: (before: string) => Effect.Effect<void, RelayStoreError>
    readonly executingRuns: () => Effect.Effect<number, RelayStoreError>
    readonly notified: (
      keys: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlySet<string>, RelayStoreError>
    readonly claimNotified: (key: string) => Effect.Effect<boolean, RelayStoreError>
    readonly releaseNotified: (key: string) => Effect.Effect<void, RelayStoreError>
    readonly pushesSeeded: () => Effect.Effect<boolean, RelayStoreError>
    readonly seedNotified: (keys: ReadonlyArray<string>) => Effect.Effect<void, RelayStoreError>
    readonly pruneNotified: (before: string) => Effect.Effect<void, RelayStoreError>
    readonly notices: (query: {
      readonly since: string
      readonly limit: number
    }) => Effect.Effect<ReadonlyArray<Notice>, RelayStoreError>
    readonly settings: () => Effect.Effect<RelaySettings, RelayStoreError>
    readonly updateSettings: (
      patch: RelaySettingsPatch
    ) => Effect.Effect<RelaySettings, RelayStoreError>
  }
>()("@arden-hq/server/persistence/relay/RelayStore") {}

export const effectiveRelayUrl = (saved: string): string =>
  process.env["ARDEN_RELAY_URL"] ?? (saved === RELAY_URLS.local ? RELAY_URLS.hosted : saved)

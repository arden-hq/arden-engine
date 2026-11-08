import type { CommandKind } from "@arden-hq/relay-protocol"
import { Clock, DateTime, Effect, Schema } from "effect"
import {
  DEFAULT_RELAY_SETTINGS,
  RelaySettingsPatchSchema,
  RelaySettingsSchema,
  RelayStore,
  RelayStoreError,
  type PairedDevice,
  type PushTarget,
  type RelayCommandRecord,
  type RelayCommandState
} from "../relay/store.js"
import type { PersistenceDeps } from "./deps.js"
import { iso } from "../../runtime/clock.js"
import { makeSettingsDocument } from "./settings-document.js"
import { modelTurnRunStatusList } from "./status-sets.js"
import { recentNotices } from "./notices.js"

interface DeviceRow {
  readonly dev: string
  readonly name: string
  readonly ed_pub: string
  readonly x_pub: string
  readonly added_at: string
  readonly last_seen_at: string | null
  readonly push_token: string | null
  readonly push_env: "sandbox" | "production" | null
  readonly push_topic: string | null
}

interface CommandRow {
  readonly cid: string
  readonly kind: CommandKind
  readonly state: RelayCommandState
  readonly result_json: string | null
  readonly created_at: string
}

const failure =
  (operation: RelayStoreError["operation"], message: string) =>
  (cause: unknown): RelayStoreError =>
    new RelayStoreError({ operation, reason: "storage", message, cause })

const device = (row: DeviceRow): PairedDevice => ({
  dev: row.dev,
  name: row.name,
  edPub: row.ed_pub,
  xPub: row.x_pub,
  addedAt: row.added_at,
  lastSeenAt: row.last_seen_at ?? undefined,
  push:
    row.push_token === null || row.push_env === null || row.push_topic === null
      ? undefined
      : { token: row.push_token, env: row.push_env, topic: row.push_topic }
})

const deviceColumns =
  "dev, name, ed_pub, x_pub, added_at, last_seen_at, push_token, push_env, push_topic"

const PUSH_SEEDED_KEY = "seeded:records"

const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const now = Effect.map(DateTime.now, DateTime.formatIso)

export const makeRelayStore = Effect.fn("SqliteRelayStore.make")(function* ({
  writer,
  reader
}: Pick<PersistenceDeps, "writer" | "reader">) {
  const sql = writer.sql
  const document = yield* makeSettingsDocument({
    writer,
    namespace: "relay_settings",
    label: "relay settings",
    schema: RelaySettingsSchema,
    patchSchema: RelaySettingsPatchSchema,
    defaults: DEFAULT_RELAY_SETTINGS,
    error: RelayStoreError
  })

  const devices = Effect.fn("SqliteRelayStore.devices")(
    function* () {
      const rows = yield* reader<DeviceRow>`
        SELECT ${sql.literal(deviceColumns)} FROM paired_devices
        WHERE revoked_at IS NULL ORDER BY added_at`
      return rows.map(device)
    },
    Effect.mapError(failure("devices", "Could not read the paired phones"))
  )

  const findDevice = Effect.fn("SqliteRelayStore.device")(
    function* (dev: string) {
      const rows = yield* reader<DeviceRow>`
        SELECT ${sql.literal(deviceColumns)} FROM paired_devices
        WHERE dev = ${dev} AND revoked_at IS NULL`
      const row = rows[0]
      return row === undefined ? undefined : device(row)
    },
    Effect.mapError(failure("devices", "Could not read the paired phone"))
  )

  const addDevice = Effect.fn("SqliteRelayStore.addDevice")(
    function* (input: Omit<PairedDevice, "addedAt" | "lastSeenAt" | "push">) {
      const at = yield* now
      const rows = yield* writer.run(sql<DeviceRow>`
        INSERT INTO paired_devices (dev, name, ed_pub, x_pub, added_at, last_seen_at, revoked_at)
        VALUES (${input.dev}, ${input.name}, ${input.edPub}, ${input.xPub}, ${at}, ${at}, NULL)
        ON CONFLICT (dev) DO UPDATE SET
          name = excluded.name, ed_pub = excluded.ed_pub, x_pub = excluded.x_pub,
          added_at = excluded.added_at, last_seen_at = excluded.last_seen_at, revoked_at = NULL,
          push_token = NULL, push_env = NULL, push_topic = NULL
        RETURNING ${sql.literal(deviceColumns)}`)
      const row = rows[0]
      if (row === undefined) return yield* Effect.die(new Error("INSERT returned no row"))
      return device(row)
    },
    Effect.mapError(failure("device_write", "Could not save the paired phone"))
  )

  const revokeDevice = Effect.fn("SqliteRelayStore.revokeDevice")(
    function* (dev: string) {
      const at = yield* now
      const rows = yield* writer.run(sql<{ readonly dev: string }>`
        UPDATE paired_devices SET revoked_at = ${at}
        WHERE dev = ${dev} AND revoked_at IS NULL RETURNING dev`)
      return rows.length > 0
    },
    Effect.mapError(failure("device_write", "Could not remove the paired phone"))
  )

  const touchDevice = Effect.fn("SqliteRelayStore.touchDevice")(
    function* (dev: string, at: string) {
      yield* writer.run(sql`
        UPDATE paired_devices SET last_seen_at = ${at}
        WHERE dev = ${dev} AND (last_seen_at IS NULL OR last_seen_at < ${at})`)
    },
    Effect.mapError(failure("device_write", "Could not record when the phone was seen"))
  )

  const setPush = Effect.fn("SqliteRelayStore.setPush")(
    function* (dev: string, push: PushTarget | undefined) {
      yield* writer.run(sql`
        UPDATE paired_devices
        SET push_token = ${push?.token ?? null}, push_env = ${push?.env ?? null},
            push_topic = ${push?.topic ?? null}
        WHERE dev = ${dev} AND revoked_at IS NULL`)
    },
    Effect.mapError(failure("device_write", "Could not save where the phone gets notifications"))
  )

  const personPresent = Effect.fn("SqliteRelayStore.personPresent")(
    function* () {
      const at = yield* now
      const rows = yield* reader<{ readonly present: number }>`
        SELECT 1 AS present FROM home_presence WHERE lease_until > ${at} LIMIT 1`
      return rows.length > 0
    },
    Effect.mapError(failure("devices", "Could not read whether you are at the Mac"))
  )

  const commandRecord = Effect.fn("SqliteRelayStore.commandRecord")(function* (row: CommandRow) {
    const result = row.result_json === null ? undefined : yield* decodeResult(row.result_json)
    return {
      cid: row.cid,
      kind: row.kind,
      state: row.state,
      result,
      createdAt: row.created_at
    } satisfies RelayCommandRecord
  })

  const command = Effect.fn("SqliteRelayStore.command")(
    function* (cid: string) {
      const rows = yield* sql<CommandRow>`
        SELECT cid, kind, state, result_json, created_at FROM relay_commands WHERE cid = ${cid}`
      const row = rows[0]
      return row === undefined ? undefined : yield* commandRecord(row)
    },
    Effect.mapError(failure("commands", "Could not read the phone command"))
  )

  const beginCommand = Effect.fn("SqliteRelayStore.beginCommand")(
    function* (input: { readonly cid: string; readonly kind: CommandKind }) {
      const at = yield* now
      const inserted = yield* writer.run(sql<{ readonly cid: string }>`
        INSERT INTO relay_commands (cid, kind, state, result_json, created_at)
        VALUES (${input.cid}, ${input.kind}, 'running', NULL, ${at})
        ON CONFLICT (cid) DO NOTHING RETURNING cid`)
      return inserted.length > 0 ? undefined : yield* command(input.cid)
    },
    Effect.mapError(failure("commands", "Could not record the phone command"))
  )

  const finishCommand = Effect.fn("SqliteRelayStore.finishCommand")(
    function* (input: {
      readonly cid: string
      readonly state: Exclude<RelayCommandState, "running">
      readonly result: Schema.Json | undefined
    }) {
      const result = input.result === undefined ? null : JSON.stringify(input.result)
      yield* writer.run(sql`
        UPDATE relay_commands SET state = ${input.state}, result_json = ${result}
        WHERE cid = ${input.cid}`)
    },
    Effect.mapError(failure("commands", "Could not record the phone command's result"))
  )

  const pruneCommands = Effect.fn("SqliteRelayStore.pruneCommands")(
    function* (before: string) {
      yield* writer.run(sql`DELETE FROM relay_commands WHERE created_at < ${before}`)
    },
    Effect.mapError(failure("commands", "Could not prune old phone commands"))
  )

  const executingRuns = Effect.fn("SqliteRelayStore.executingRuns")(
    function* () {
      const rows = yield* reader<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM chat_runs WHERE status IN ${modelTurnRunStatusList}`
      return rows[0]?.count ?? 0
    },
    Effect.mapError(failure("runs", "Could not count running work"))
  )

  const notified = Effect.fn("SqliteRelayStore.notified")(
    function* (keys: ReadonlyArray<string>) {
      if (keys.length === 0) return new Set<string>()
      const rows = yield* reader<{ readonly key: string }>`
        SELECT key FROM relay_push_notified WHERE key IN ${reader.in(keys)}`
      return new Set(rows.map((row) => row.key))
    },
    Effect.mapError(failure("push", "Could not read what was notified"))
  )

  const claimNotified = Effect.fn("SqliteRelayStore.claimNotified")(
    function* (key: string) {
      const at = iso(yield* Clock.currentTimeMillis)
      const claimed = yield* writer.run(sql<{ readonly key: string }>`
        INSERT INTO relay_push_notified (key, notified_at) VALUES (${key}, ${at})
        ON CONFLICT(key) DO NOTHING RETURNING key`)
      return claimed.length > 0
    },
    Effect.mapError(failure("push", "Could not record what was notified"))
  )

  const releaseNotified = Effect.fn("SqliteRelayStore.releaseNotified")(
    function* (key: string) {
      yield* writer.run(sql`DELETE FROM relay_push_notified WHERE key = ${key}`)
    },
    Effect.mapError(failure("push", "Could not release what was notified"))
  )

  const pushesSeeded = Effect.fn("SqliteRelayStore.pushesSeeded")(
    function* () {
      const rows = yield* reader<{ readonly key: string }>`
        SELECT key FROM relay_push_notified WHERE key = ${PUSH_SEEDED_KEY}`
      return rows.length > 0
    },
    Effect.mapError(failure("push", "Could not read what was notified"))
  )

  const seedNotified = Effect.fn("SqliteRelayStore.seedNotified")(
    function* (keys: ReadonlyArray<string>) {
      const at = iso(yield* Clock.currentTimeMillis)
      yield* writer.transact(
        Effect.forEach(
          [...keys, PUSH_SEEDED_KEY],
          (key) => sql`INSERT INTO relay_push_notified (key, notified_at) VALUES (${key}, ${at})
            ON CONFLICT(key) DO NOTHING`,
          { discard: true }
        )
      )
    },
    Effect.mapError(failure("push", "Could not record what was notified"))
  )

  const pruneNotified = Effect.fn("SqliteRelayStore.pruneNotified")(
    function* (before: string) {
      yield* writer.run(sql`DELETE FROM relay_push_notified
        WHERE notified_at < ${before} AND key <> ${PUSH_SEEDED_KEY}`)
    },
    Effect.mapError(failure("push", "Could not forget old notifications"))
  )

  const notices = (query: { readonly since: string; readonly limit: number }) =>
    recentNotices(reader, query).pipe(
      Effect.mapError(failure("push", "Could not read the notices to push"))
    )

  return RelayStore.of({
    devices,
    device: findDevice,
    addDevice,
    revokeDevice,
    touchDevice,
    setPush,
    personPresent,
    command,
    beginCommand,
    finishCommand,
    pruneCommands,
    executingRuns,
    notified,
    claimNotified,
    releaseNotified,
    pushesSeeded,
    seedNotified,
    pruneNotified,
    notices,
    settings: document.read,
    updateSettings: (patch) => document.update(patch)
  })
})

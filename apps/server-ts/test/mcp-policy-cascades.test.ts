import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { McpStore, type McpStoredServer } from "../src/persistence/mcp/store.js"
import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"

const connection = (name: string): McpStoredServer => ({
  name,
  enabled: true,
  presetId: null,
  transport: { type: "http", url: `https://${name}.invalid/mcp`, auth: "oauth", headerKeys: [] }
})

it("invalidates shared credential permissions atomically without restoring stale connection state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-mcp-identity-"))
  const filename = join(directory, "arden.db")
  const layer = () =>
    sqlitePersistenceLayer({ dataDir: null, filename }).pipe(
      Layer.provide(PersistenceWriteQueue.layer)
    )
  try {
    const retained = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpStore
        const permissions = yield* PermissionRules
        const spaces = yield* SpaceStore
        const owner = yield* spaces.create({ name: "MCP permissions" })
        for (const name of ["shared-a", "shared-b", "removed", "unrelated"]) {
          yield* store.create(connection(name))
        }
        const database = new DatabaseSync(filename)
        try {
          const revision = (name: string) => {
            const value = database
              .prepare("SELECT updated_at FROM mcp_servers WHERE name = ?")
              .get(name)?.updated_at
            if (typeof value !== "string") throw new Error("Missing MCP revision")
            return value
          }
          const grant = (name: string) =>
            database
              .prepare(
                `INSERT INTO permission_rules (rule_id, list_kind, space_id, subject_kind, tool_name,
          server_name, decision, source_kind, created_at)
          VALUES (?, 'space', ?, 'tool', ?, ?, 'allow', 'migrated', ?)`
              )
              .run(name, owner.space_id, `mcp__${name}__read`, name, new Date().toISOString())
          for (const name of ["shared-a", "shared-b", "removed", "unrelated"]) grant(name)
          yield* store.remove("removed")
          const future = new Date(Date.now() + 60_000).toISOString()
          database
            .prepare("UPDATE mcp_servers SET updated_at = ? WHERE name = ?")
            .run(future, "shared-a")
          const edited = {
            ...connection("shared-a"),
            enabled: false,
            transport: {
              type: "http",
              url: "https://new-endpoint.invalid/mcp",
              auth: "headers",
              headerKeys: ["Authorization"]
            }
          } satisfies McpStoredServer
          yield* store.save(edited)
          const savedRevision = revision("shared-a")
          expect(Date.parse(savedRevision)).toBeGreaterThan(Date.parse(future))
          expect((yield* permissions.list()).map((permission) => permission.id).sort()).toEqual([
            "shared-b",
            "unrelated"
          ])
          grant("shared-a")
          const before = yield* store.list()
          const unrelatedRevision = revision("unrelated")
          const otherGrant = (yield* permissions.list()).filter(
            (permission) => permission.id === "unrelated"
          )
          const beforeGrants = yield* permissions.list()
          const sharedBRevision = revision("shared-b")
          database.exec(`CREATE TRIGGER fixture_revoke_failure BEFORE DELETE ON permission_rules
          WHEN OLD.server_name = 'shared-b' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`)
          expect(
            yield* store.invalidatePermissions(["shared-a", "shared-b"]).pipe(Effect.result)
          ).toMatchObject({
            _tag: "Failure",
            failure: { operation: "invalidate_permissions", reason: "storage" }
          })
          expect(yield* permissions.list()).toEqual(beforeGrants)
          expect([revision("shared-a"), revision("shared-b")]).toEqual([
            savedRevision,
            sharedBRevision
          ])
          database.exec("DROP TRIGGER fixture_revoke_failure")
          yield* store.invalidatePermissions(["shared-a", "shared-b", "removed", "shared-a"])
          expect(yield* store.list()).toEqual(before)
          expect(yield* permissions.list()).toEqual(otherGrant)
          const invalidatedRevision = revision("shared-a")
          expect(Date.parse(invalidatedRevision)).toBeGreaterThan(Date.parse(savedRevision))
          expect(revision("unrelated")).toBe(unrelatedRevision)
          yield* store.invalidatePermissions([])
          expect(revision("shared-a")).toBe(invalidatedRevision)
          yield* store.setEnabled("shared-a", true)
          const enabledRevision = revision("shared-a")
          expect(Date.parse(enabledRevision)).toBeGreaterThan(Date.parse(invalidatedRevision))
          expect(yield* store.get("shared-a")).toEqual({ ...edited, enabled: true })
          yield* store.setEnabled("shared-a", false)
          expect(Date.parse(revision("shared-a"))).toBeGreaterThan(Date.parse(enabledRevision))
          return { servers: yield* store.list(), permissions: yield* permissions.list() }
        } finally {
          database.close()
        }
      }).pipe(Effect.provide(layer()))
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpStore
        const permissions = yield* PermissionRules
        expect(yield* store.list()).toEqual(retained.servers)
        expect(yield* permissions.list()).toEqual(retained.permissions)
        expect(yield* store.get("removed")).toBeNull()
      }).pipe(Effect.provide(layer()))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("never recreates a removed MCP connection through a stale update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arden-mcp-removal-"))
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* McpStore
        const original = yield* store.create(connection("removed"))
        yield* store.remove(original.name)
        expect(yield* store.save(original).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "save", reason: "not_found" }
        })
        expect(yield* store.setEnabled(original.name, true).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "set_enabled", reason: "not_found" }
        })
        expect(yield* store.list()).toEqual([])
      }).pipe(
        Effect.provide(
          sqlitePersistenceLayer({ dataDir: null, filename: join(directory, "arden.db") }).pipe(
            Layer.provide(PersistenceWriteQueue.layer)
          )
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

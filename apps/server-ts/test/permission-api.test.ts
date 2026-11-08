import { permissionDecoders, permissionRoutes } from "@arden-hq/protocol/permissions"
import { Schema } from "effect"
import { expect, it } from "vitest"
import { startServer } from "../src/index.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

it("exposes server-owned chat permissions and rejects unknown modes", async () => {
  const managedRoot = await mkdtemp(join(tmpdir(), "arden-permission-managed-"))
  const server = await startServer({
    port: 0,
    managedOutputRoot: join(managedRoot, "managed-outputs")
  })
  try {
    const created = await server.fetch("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Permission test" })
    })
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))(
      await created.json()
    )
    const path = `/permissions/sessions/${session.session_id}`
    expect(await (await server.fetch(path)).json()).toEqual({
      kind: "chat",
      approval_mode: "safe"
    })
    const changed = await server.fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_mode: "allow" })
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toEqual({
      kind: "chat",
      approval_mode: "allow"
    })
    expect(await (await server.fetch(path)).json()).toEqual({
      kind: "chat",
      approval_mode: "allow"
    })
    const invalid = await server.fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_mode: "everything" })
    })
    expect(invalid.status).toBe(400)
  } finally {
    await server.stop()
    await rm(managedRoot, { recursive: true, force: true })
  }
})

it("Settings saves, changes and removes rules, and refuses what no rule may say", async () => {
  const managedRoot = await mkdtemp(join(tmpdir(), "arden-permission-rules-"))
  const server = await startServer({
    port: 0,
    managedOutputRoot: join(managedRoot, "managed-outputs")
  })
  const send = (method: string, path: string, body?: unknown) =>
    server.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const listed = async (response: Response) =>
    permissionDecoders.rules(await response.json()).rules.map(({ list, decision, subject }) => ({
      list,
      decision,
      subject
    }))
  try {
    expect(await listed(await server.fetch(permissionRoutes.rules))).toEqual([])
    const words = { kind: "words", text: "Edit your email" } as const
    expect(
      await listed(
        await send("POST", permissionRoutes.rules, {
          list: { kind: "global" },
          decision: "allow",
          subject: { kind: "command", command: "/bin/ls -la /tmp" }
        })
      )
    ).toEqual([
      { list: { kind: "global" }, decision: "allow", subject: { kind: "command", words: "ls" } }
    ])
    await send("POST", permissionRoutes.rules, {
      list: { kind: "system" },
      decision: "ask",
      subject: words
    })
    const both = permissionDecoders.rules(
      await (await server.fetch(permissionRoutes.rules)).json()
    ).rules
    const own = both.find((rule) => rule.list.kind === "system")
    if (own === undefined) throw new Error("expected the system rule")
    expect(
      await listed(await send("PATCH", permissionRoutes.rule(own.id), { decision: "never" }))
    ).toContainEqual({ list: { kind: "system" }, decision: "never", subject: words })
    expect(await listed(await send("DELETE", permissionRoutes.rule(own.id)))).toEqual([
      { list: { kind: "global" }, decision: "allow", subject: { kind: "command", words: "ls" } }
    ])

    const refused = await Promise.all([
      send("POST", permissionRoutes.rules, {
        list: { kind: "global" },
        decision: "allow",
        subject: { kind: "host_commands" }
      }),
      send("POST", permissionRoutes.rules, {
        list: { kind: "global" },
        decision: "allow",
        subject: { kind: "tool", tool: "space_archive" }
      }),
      send("POST", permissionRoutes.rules, {
        list: { kind: "global" },
        decision: "allow",
        subject: { kind: "command", command: "bash -c 'rm -rf ~'" }
      })
    ])
    expect(refused.map((response) => response.status)).toEqual([422, 422, 422])
    const again = await send("POST", permissionRoutes.rules, {
      list: { kind: "global" },
      decision: "never",
      subject: { kind: "command", command: "/bin/ls" }
    })
    expect(again.status).toBe(409)
    expect(
      await listed(
        await send("POST", permissionRoutes.rules, {
          list: { kind: "global" },
          decision: "ask",
          subject: { kind: "host_commands" }
        })
      )
    ).toContainEqual({
      list: { kind: "global" },
      decision: "ask",
      subject: { kind: "host_commands" }
    })
  } finally {
    await server.stop()
    await rm(managedRoot, { recursive: true, force: true })
  }
})

it("a Space's rules are on that Space's page alone", async () => {
  const managedRoot = await mkdtemp(join(tmpdir(), "arden-space-rules-"))
  const server = await startServer({
    port: 0,
    managedOutputRoot: join(managedRoot, "managed-outputs")
  })
  const send = (method: string, path: string, body?: unknown) =>
    server.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  try {
    const created = await send("POST", "/spaces", { name: "Lab" })
    expect(created.status).toBe(200)
    const space = Schema.decodeUnknownSync(Schema.Struct({ space_id: Schema.String }))(
      await created.json()
    )
    const list = { kind: "space", space_id: space.space_id } as const
    const words = { kind: "words", text: "Delete pods I started" } as const
    const saved = permissionDecoders.rules(
      await (
        await send("POST", permissionRoutes.rules, { list, decision: "allow", subject: words })
      ).json()
    ).rules
    expect(saved.map(({ list, decision, subject }) => ({ list, decision, subject }))).toEqual([
      { list, decision: "allow", subject: words }
    ])
    expect(
      permissionDecoders.rules(await (await server.fetch(permissionRoutes.rules)).json()).rules
    ).toEqual([])
    const rule = saved[0]
    if (rule === undefined) throw new Error("expected the Space rule")
    expect(
      permissionDecoders
        .rules(
          await (await send("PATCH", permissionRoutes.rule(rule.id), { decision: "ask" })).json()
        )
        .rules.map(({ decision }) => decision)
    ).toEqual(["ask"])
    expect(
      permissionDecoders.rules(await (await send("DELETE", permissionRoutes.rule(rule.id))).json())
        .rules
    ).toEqual([])
    expect(
      permissionDecoders.rules(
        await (await server.fetch(permissionRoutes.spaceRules(space.space_id))).json()
      ).rules
    ).toEqual([])
    const missing = await send("POST", permissionRoutes.rules, {
      list: { kind: "space", space_id: "no-such-space" },
      decision: "allow",
      subject: words
    })
    expect(missing.status).toBe(404)
  } finally {
    await server.stop()
    await rm(managedRoot, { recursive: true, force: true })
  }
})

import { PermissionRules } from "../src/persistence/permissions/rules.js"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { ChatWriteStore } from "../src/persistence/chat/store.js"
import { SpaceStore } from "../src/persistence/spaces/store.js"
import { RunQueries } from "../src/persistence/runs/queries.js"
import { SessionQueries } from "../src/persistence/sessions/queries.js"
import { SessionStore } from "../src/persistence/sessions/store.js"
import { ToolHistoryQueries } from "../src/persistence/tools/history-queries.js"
import { ToolExecutionStore } from "../src/persistence/tools/store.js"
import { PersistenceWriteQueue } from "../src/persistence/write-queue.js"
import { sqlitePersistenceLayer } from "./fixtures/temp-database.js"
import { insideLocalFolder, sessionPathPolicy } from "../src/storage/local-paths.js"
import { fileWriteTools } from "../src/tools/files-write.js"
import { present, serverRunContext } from "./kit.js"

let base = ""
let videos = ""
let margin = ""

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "arden-folder-grant-")))
  videos = join(base, "videos")
  margin = join(base, "margin")
  await mkdir(videos)
  await mkdir(join(margin, ".git"), { recursive: true })
  await mkdir(join(margin, "src"))
  await mkdir(join(margin, "docs"))
  await writeFile(join(margin, "src", "index.ts"), "export const a = 1\n")
  await writeFile(join(margin, "docs", "notes.md"), "draft\n")
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

type Place = "space" | "chat"
type Choice = "once" | "add_folder"

const inDatabase = async <A, E>(
  database: string,
  program: Effect.Effect<
    A,
    E,
    | ChatWriteStore
    | PermissionRules
    | SessionStore
    | SessionQueries
    | SpaceStore
    | RunQueries
    | ToolExecutionStore
    | ToolHistoryQueries
  >
) => {
  await mkdir(join(base, database))
  return Effect.runPromise(
    program.pipe(
      Effect.provide(
        sqlitePersistenceLayer({ dataDir: null, filename: join(base, database, "arden.db") }).pipe(
          Layer.provide(PersistenceWriteQueue.layer)
        )
      )
    )
  )
}

const startRun = (place: Place) =>
  Effect.gen(function* () {
    const spaces = yield* SpaceStore
    const space = place === "space" ? yield* spaces.create({ name: "Margin" }) : null
    const { sessionId } = yield* (yield* SessionStore).create({
      name: "Edit",
      ...(space === null ? {} : { spaceId: space.space_id })
    })
    const run = yield* (yield* ChatWriteStore).start({
      sessionId,
      clientId: "request",
      requestHash: "request",
      assistantMessageId: "answer",
      message: {
        message_id: "request",
        client_id: "request",
        role: "user",
        content: "Edit margin",
        created_at: new Date().toISOString()
      }
    })
    return { sessionId, runId: run.runId, spaceId: space?.space_id }
  })

const answerCard = (
  place: Place,
  choice: Choice,
  started: {
    readonly sessionId: string
    readonly runId: string
    readonly spaceId: string | undefined
  },
  toolCallId: string
) =>
  Effect.gen(function* () {
    const [pending] = yield* (yield* ToolHistoryQueries).pendingApprovals(started.sessionId)
    yield* (yield* ToolExecutionStore).resolve({
      runId: started.runId,
      toolCallId,
      approved: true,
      ...(choice === "add_folder" && place === "space" ? { attachFolderToSpace: true } : {}),
      ...(choice === "add_folder" && place === "chat" ? { grantStanding: true } : {})
    })
    const folders = (yield* (yield* PermissionRules).list()).flatMap((rule) =>
      rule.subject.kind === "path" &&
      rule.subject.access === "change" &&
      rule.decision === "allow" &&
      (started.spaceId === undefined
        ? rule.list.kind === "global"
        : rule.list.kind === "space" && rule.list.spaceId === started.spaceId)
        ? [rule.subject.path]
        : []
    )
    return { pending, folders }
  })

const uploadIn = (place: Place, choice: Choice) =>
  Effect.gen(function* () {
    const started = yield* startRun(place)
    const tools = yield* ToolExecutionStore
    const call = {
      runId: started.runId,
      sessionId: started.sessionId,
      toolCallId: "upload",
      toolName: "browser_upload",
      changesState: true,
      arguments: { files: [{ path: join(videos, "demo.mp4") }] }
    }
    yield* tools.begin(call)
    yield* tools.pause(call, {
      reason: "approval",
      presentation: {
        title: "Upload a file to drive.google.com?",
        fields: [{ label: "Path", value: join(videos, "demo.mp4") }],
        approve_label: "Upload once"
      },
      data: {
        tab_ref: "tab",
        profile_ref: "default",
        origin: "https://drive.google.com",
        expected_revision: 1,
        files: [{ key: join(videos, "demo.mp4"), name: "demo.mp4", size: 11 }],
        ...(started.spaceId === undefined
          ? {
              chat_folder_grant: {
                _tag: "ChatFolderGrant",
                session_id: started.sessionId,
                local_folder: videos
              }
            }
          : {
              space_folder_grant: {
                _tag: "SpaceFolderGrant",
                space_id: started.spaceId,
                local_folder: videos
              }
            })
      }
    })
    return yield* answerCard(place, choice, started, "upload")
  })

type FileTool = "file_edit" | "file_write"

const changes = (tool: FileTool) =>
  tool === "file_edit"
    ? {
        first: { path: join(margin, "src", "index.ts"), old_text: "1", new_text: "2" },
        second: { path: join(margin, "docs", "notes.md"), old_text: "draft", new_text: "done" }
      }
    : {
        first: { path: join(margin, "src", "new.ts"), content: "export const b = 2\n" },
        second: { path: join(margin, "docs", "notes.md"), content: "done\n" }
      }

const changeIn = (place: Place, tool: FileTool) =>
  Effect.gen(function* () {
    const started = yield* startRun(place)
    const services = {
      spaces: yield* SpaceStore,
      sessions: yield* SessionQueries,
      runs: yield* RunQueries,
      rules: yield* PermissionRules,
      dataDir: join(base, "arden-state")
    }
    const edit = present(
      fileWriteTools(services).find((candidate) => candidate.definition.name === tool),
      tool
    )
    const { first: firstInput, second: secondInput } = changes(tool)
    const ctx = (toolCallId: string) => ({
      run: serverRunContext({
        runId: started.runId,
        sessionId: started.sessionId,
        approvalMode: "safe"
      }),
      toolCallId,
      signal: new AbortController().signal,
      messages: []
    })
    const asked = yield* Effect.promise(async () =>
      edit.definition.approvalRequirement?.(firstInput, ctx("change-1"))
    )
    if (asked?.data === undefined) throw new Error("the change outside the folders did not ask")
    const tools = yield* ToolExecutionStore
    const call = {
      runId: started.runId,
      sessionId: started.sessionId,
      toolCallId: "change-1",
      toolName: tool,
      changesState: true,
      arguments: firstInput
    }
    yield* tools.begin(call)
    yield* tools.pause(call, { reason: "approval", data: asked.data })
    const answered = yield* answerCard(place, "add_folder", started, "change-1")
    const next = yield* Effect.promise(async () =>
      edit.definition.approvalRequirement?.(secondInput, ctx("change-2"))
    )
    const policy = yield* Effect.promise(() =>
      sessionPathPolicy(services, {
        sessionId: started.sessionId,
        runId: started.runId,
        signal: new AbortController().signal
      })
    )
    return {
      started,
      asked: asked.data,
      ...answered,
      nextAsks: next !== undefined,
      secondInside: insideLocalFolder(policy, secondInput.path)
    }
  })

describe("folder grant on an approval card", () => {
  it.each(["space"] as const)(
    "a browser upload offers the %s grant, and adds the folder only when the user picks it",
    async (place) => {
      const added = await inDatabase(`upload-${place}-add`, uploadIn(place, "add_folder"))
      expect(added.pending).toMatchObject({
        ...(place === "space"
          ? { can_attach_folder_to_space: true }
          : { can_attach_folder_to_chat: true }),
        grant_folder: expect.stringMatching(/\/videos$/)
      })
      expect(added.folders).toEqual([videos])
      const once = await inDatabase(`upload-${place}-once`, uploadIn(place, "once"))
      expect(once.folders ?? []).toEqual([])
    }
  )

  it("a browser upload in a loose chat offers no folder to keep", async () => {
    const once = await inDatabase("upload-chat-once", uploadIn("chat", "once"))
    expect(once.pending).not.toHaveProperty("can_attach_folder_to_chat")
    expect(once.pending).not.toHaveProperty("grant_folder")
    expect(once.folders).toEqual([])
  })

  it.each([
    ["file_edit", "space"],
    ["file_write", "space"]
  ] as const)(
    "%s outside the folders offers its project to the %s, and the next change there runs without asking",
    async (tool, place) => {
      const result = await inDatabase(`${tool}-${place}`, changeIn(place, tool))
      expect(result.asked).toMatchObject(
        place === "space"
          ? {
              path: changes(tool).first.path,
              space_folder_grant: {
                _tag: "SpaceFolderGrant",
                space_id: result.started.spaceId,
                local_folder: margin
              }
            }
          : {
              path: changes(tool).first.path,
              chat_folder_grant: {
                _tag: "ChatFolderGrant",
                session_id: result.started.sessionId,
                local_folder: margin
              }
            }
      )
      expect(result.pending).toMatchObject({
        ...(place === "space"
          ? { can_attach_folder_to_space: true }
          : { can_attach_folder_to_chat: true }),
        grant_folder: expect.stringMatching(/\/margin$/)
      })
      expect(result.folders).toEqual([margin])
      expect({ nextAsks: result.nextAsks, secondInside: result.secondInside }).toEqual({
        nextAsks: false,
        secondInside: true
      })
    }
  )
})

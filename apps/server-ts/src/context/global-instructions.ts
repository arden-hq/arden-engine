import { formatBytes } from "@arden-hq/std/count"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { lstat, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { isErrnoCode } from "../fs/private-store.js"
import { PROMPT_CATALOG } from "../prompts/catalog.js"
import { baseSystemPrompt } from "../models/instructions.js"
import { joinPromptSections, renderPromptSection } from "../prompts/format.js"
import {
  atomicCompareAndSwap,
  LocalRevisionConflict,
  revisionOrAbsent
} from "../storage/local-paths.js"
import {
  renderInstructionSource,
  type LocalInstructionManifestEntry
} from "./local-instructions.js"
import { sha256Hex } from "@arden-hq/std/hash"

const GLOBAL_INSTRUCTIONS_FILE = "AGENTS.md"
const MAX_BYTES = 128 * 1024

interface GlobalInstructionsSnapshot {
  readonly content: string | undefined
  readonly version: string
  readonly bytes: number
}

export class GlobalInstructionsError extends Schema.TaggedError<GlobalInstructionsError>()(
  "GlobalInstructionsError",
  {
    operation: Schema.Literals(["read", "replace"] as const),
    reason: Schema.Literals(["invalid", "conflict", "storage"] as const),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

const error = (
  operation: GlobalInstructionsError["operation"],
  reason: GlobalInstructionsError["reason"],
  message: string,
  cause?: unknown
): GlobalInstructionsError =>
  new GlobalInstructionsError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause })
  })

const readSnapshot = Effect.fn("GlobalInstructions.readSnapshot")(function* (filename: string) {
  const status = yield* Effect.tryPromise({
    try: () => lstat(filename),
    catch: (cause) => cause
  }).pipe(
    Effect.catch((cause) =>
      isErrnoCode(cause, "ENOENT")
        ? Effect.succeed(undefined)
        : Effect.fail(error("read", "storage", "Global instructions could not be inspected", cause))
    )
  )
  if (status === undefined) {
    return { content: undefined, version: "absent", bytes: 0 } satisfies GlobalInstructionsSnapshot
  }
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_BYTES) {
    return yield* error(
      "read",
      "invalid",
      `${GLOBAL_INSTRUCTIONS_FILE} is not a regular file under ${formatBytes(MAX_BYTES)}`
    )
  }
  const bytes = yield* Effect.tryPromise({
    try: () => readFile(filename),
    catch: (cause) => error("read", "storage", "Global instructions could not be read", cause)
  })
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      error("read", "invalid", `${GLOBAL_INSTRUCTIONS_FILE} is not valid UTF-8`, cause)
  })
  const content = text.trim()
  return {
    content: content === "" ? undefined : content,
    version: sha256Hex(bytes),
    bytes: bytes.byteLength
  } satisfies GlobalInstructionsSnapshot
})

export class GlobalInstructions extends Context.Service<
  GlobalInstructions,
  {
    readonly file: string
    readonly read: () => Effect.Effect<GlobalInstructionsSnapshot, GlobalInstructionsError>
    readonly replace: (input: {
      readonly content: string
      readonly expectedVersion: string
    }) => Effect.Effect<GlobalInstructionsSnapshot, GlobalInstructionsError>
  }
>()("@arden-hq/server/context/GlobalInstructions") {}

const make = Effect.fn("GlobalInstructions.make")(function* (file: string) {
  const lock = yield* Semaphore.make(1)

  const read = () => lock.withPermit(readSnapshot(file))

  const replace = Effect.fn("GlobalInstructions.replace")(function* (input: {
    readonly content: string
    readonly expectedVersion: string
  }) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const content = input.content.trim()
        const text = content === "" ? "" : `${content}\n`
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
          return yield* error("replace", "invalid", "Global instructions are too large")
        }
        const current = yield* readSnapshot(file)
        if (current.content === (content === "" ? undefined : content)) return current
        if (current.version !== input.expectedVersion) {
          return yield* error(
            "replace",
            "conflict",
            "Global instructions changed after they were read"
          )
        }
        const written = yield* Effect.tryPromise({
          try: () => atomicCompareAndSwap(file, text, input.expectedVersion),
          catch: (cause) =>
            cause instanceof LocalRevisionConflict
              ? error(
                  "replace",
                  "conflict",
                  "Global instructions changed after they were reviewed",
                  cause
                )
              : error("replace", "storage", "Global instructions could not be replaced", cause)
        })
        return {
          content: content === "" ? undefined : content,
          version: written.revision,
          bytes: written.bytes
        } satisfies GlobalInstructionsSnapshot
      })
    )
  })

  return GlobalInstructions.of({ file, read, replace })
})

const LEGACY_FILE = "directives.json"
const LegacyDocument = Schema.fromJsonString(Schema.Struct({ content: Schema.String }))

type DirectivesMove = "moved" | "already_moved" | "nothing_to_move" | "unreadable"

const moveDirectivesJson = async (file: string): Promise<DirectivesMove> => {
  if ((await revisionOrAbsent(file)) !== "absent") return "already_moved"
  let raw: string
  try {
    raw = await readFile(join(dirname(file), LEGACY_FILE), "utf8")
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return "nothing_to_move"
    return "unreadable"
  }
  const decoded = Schema.decodeUnknownOption(LegacyDocument)(raw)
  if (decoded._tag === "None") return "unreadable"
  try {
    await atomicCompareAndSwap(file, decoded.value.content, "absent")
    return "moved"
  } catch (cause) {
    if (cause instanceof LocalRevisionConflict) return "already_moved"
    throw cause
  }
}

export const globalInstructionsLayer = (file: string): Layer.Layer<GlobalInstructions> =>
  Layer.effect(
    GlobalInstructions,
    Effect.gen(function* () {
      const moved = yield* Effect.tryPromise(() => moveDirectivesJson(file)).pipe(
        Effect.orElseSucceed((): DirectivesMove => "unreadable")
      )
      if (moved === "unreadable") {
        yield* Effect.logWarning(
          `${LEGACY_FILE} could not be moved to ${GLOBAL_INSTRUCTIONS_FILE} and stays where it is`
        )
      }
      return yield* make(file)
    })
  )

export type GlobalInstructionsLoad =
  | { readonly kind: "read"; readonly snapshot: GlobalInstructionsSnapshot }
  | { readonly kind: "failed"; readonly error: GlobalInstructionsError }

export const loadForRun = (
  instructions: GlobalInstructions["Service"]
): Effect.Effect<GlobalInstructionsLoad> =>
  instructions.read().pipe(
    Effect.map((snapshot): GlobalInstructionsLoad => ({ kind: "read", snapshot })),
    Effect.catch((error) =>
      Effect.as(Effect.logWarning("Running without the global instructions", { error }), {
        kind: "failed",
        error
      } satisfies GlobalInstructionsLoad)
    )
  )

export const globalInstructionManifest = (
  file: string,
  load: GlobalInstructionsLoad
): ReadonlyArray<LocalInstructionManifestEntry> => {
  const entry = (
    status: LocalInstructionManifestEntry["status"],
    digest: string | null
  ): LocalInstructionManifestEntry => ({
    root: dirname(file),
    path: file,
    scope: dirname(file),
    status,
    digest
  })
  if (load.kind === "failed") return [entry("unreadable", null)]
  if (load.snapshot.version === "absent") return []
  return load.snapshot.content === undefined
    ? [entry("empty", null)]
    : [entry("loaded", load.snapshot.version)]
}

export const chatSystemPrompt = (
  assistantName: string,
  file: string,
  load: GlobalInstructionsLoad
): string =>
  joinPromptSections([
    baseSystemPrompt(assistantName),
    load.kind === "failed" || load.snapshot.content === undefined
      ? undefined
      : renderPromptSection(
          "Global instructions",
          [
            PROMPT_CATALOG.globalInstructions.render({
              assistant_name: JSON.stringify(assistantName)
            }).text,
            renderInstructionSource(file, "loaded", load.snapshot.content)
          ].join("\n\n")
        )
  ]) ?? ""

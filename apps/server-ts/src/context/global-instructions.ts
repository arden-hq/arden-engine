import { formatBytes } from "@arden-hq/std/count"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { lstat, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { isErrnoCode } from "../fs/private-store.js"
import {
  type InstructionVersion,
  InstructionVersionStore,
  type InstructionVersionStoreError,
  type InstructionWriter
} from "../persistence/instructions/store.js"
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
    operation: Schema.Literals(["read", "replace", "history"] as const),
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
    /** Replaces the rules and records the new version under `writer`. */
    readonly replace: (input: {
      readonly content: string
      readonly expectedVersion: string
      readonly writer: Extract<InstructionWriter, { readonly kind: "chat" | "restore" }>
    }) => Effect.Effect<GlobalInstructionsSnapshot, GlobalInstructionsError>
    /** Newest first, with how many versions exist in all. */
    readonly versions: (input: {
      readonly limit: number
    }) => Effect.Effect<
      { readonly versions: ReadonlyArray<InstructionVersion>; readonly total: number },
      GlobalInstructionsError
    >
    readonly version: (
      version: number
    ) => Effect.Effect<InstructionVersion | undefined, GlobalInstructionsError>
  }
>()("@arden-hq/server/context/GlobalInstructions") {}

const historyError = (cause: InstructionVersionStoreError): GlobalInstructionsError =>
  error("history", "storage", "The standing rules history could not be read", cause)

const make = Effect.fn("GlobalInstructions.make")(function* (file: string) {
  const lock = yield* Semaphore.make(1)
  const store = yield* InstructionVersionStore

  // The file is the live copy and wins: a history that cannot be written never stops the rules
  // from loading or changing. A change it missed is adopted on the next read as an outside edit.
  const record = (snapshot: GlobalInstructionsSnapshot, writer: InstructionWriter) =>
    store.append({ content: snapshot.content ?? "", digest: snapshot.version, writer }).pipe(
      Effect.asVoid,
      Effect.catch((cause) =>
        Effect.logWarning("A standing rules version was not recorded", { cause })
      )
    )

  /** Records a version the history does not have yet: the first one, or an outside edit. */
  const adopt = (snapshot: GlobalInstructionsSnapshot) =>
    store.latest().pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.logWarning("The standing rules history could not be read", { cause }),
        onSuccess: (latest) => {
          if (latest === undefined) return record(snapshot, { kind: "seed" })
          if (latest.digest === snapshot.version) return Effect.void
          return record(snapshot, { kind: "outside" })
        }
      })
    )

  const read = () => lock.withPermit(readSnapshot(file).pipe(Effect.tap(adopt)))

  const replace = Effect.fn("GlobalInstructions.replace")(function* (input: {
    readonly content: string
    readonly expectedVersion: string
    readonly writer: Extract<InstructionWriter, { readonly kind: "chat" | "restore" }>
  }) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const content = input.content.trim()
        const text = content === "" ? "" : `${content}\n`
        if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
          return yield* error("replace", "invalid", "Global instructions are too large")
        }
        const current = yield* readSnapshot(file)
        yield* adopt(current)
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
        const snapshot = {
          content: content === "" ? undefined : content,
          version: written.revision,
          bytes: written.bytes
        } satisfies GlobalInstructionsSnapshot
        yield* record(snapshot, input.writer)
        return snapshot
      })
    )
  })

  return GlobalInstructions.of({
    file,
    read,
    replace,
    versions: (input) => store.list(input).pipe(Effect.mapError(historyError)),
    version: (version) => store.get(version).pipe(Effect.mapError(historyError))
  })
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

/** The rules service. Its first start records the rules as they are as version one. */
export const globalInstructionsLayer = (
  file: string
): Layer.Layer<GlobalInstructions, never, InstructionVersionStore> =>
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
      const instructions = yield* make(file)
      yield* instructions
        .read()
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("The standing rules could not be read at start", { cause })
          )
        )
      return instructions
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

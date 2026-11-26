import { Effect, Schema } from "effect"
import {
  AcknowledgeTaskResultInputSchema,
  CreateChatTaskInputSchema,
  CreateLooseTaskInputSchema,
  CreateSpaceTaskAttachmentInputSchema,
  CreateSpaceTaskCommentInputSchema,
  CreateSpaceTaskInputSchema,
  MoveTaskToChatInputSchema,
  NewTaskInputSchema,
  SpaceSnapshotSchema,
  SpaceTaskEventSchema,
  StopSpaceTaskInputSchema
} from "./schema.js"

type EncodedText = Effect.Effect<string, Schema.SchemaError>
type Decoded<S extends Schema.Decoder<unknown>> = Effect.Effect<S["Type"], Schema.SchemaError>

const strict = { onExcessProperty: "error" } as const

export const encodeMoveTaskToChatEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(MoveTaskToChatInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeAcknowledgeTaskResultEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(AcknowledgeTaskResultInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

export const encodeCreateChatTaskRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(CreateChatTaskInputSchema)(value, strict).pipe(
    Effect.map((input) => JSON.stringify(input))
  )

export const decodeSpaceTaskEventEffect = (value: unknown): Decoded<typeof SpaceTaskEventSchema> =>
  Schema.decodeUnknownEffect(SpaceTaskEventSchema)(value)

export const decodeSpaceSnapshotEffect = (value: unknown): Decoded<typeof SpaceSnapshotSchema> =>
  Schema.decodeUnknownEffect(SpaceSnapshotSchema)(value)

export const decodeCreateSpaceTaskInputEffect = (
  value: unknown
): Decoded<typeof CreateSpaceTaskInputSchema> =>
  Schema.decodeUnknownEffect(CreateSpaceTaskInputSchema)(value, strict).pipe(
    Effect.map((input) => (input.body?.trim() === "" ? { ...input, body: null } : input))
  )

export const decodeCreateSpaceTaskCommentInputEffect = (
  value: unknown
): Decoded<typeof CreateSpaceTaskCommentInputSchema> =>
  Schema.decodeUnknownEffect(CreateSpaceTaskCommentInputSchema)(value, strict)

export const decodeCreateSpaceTaskAttachmentInputEffect = (
  value: unknown
): Decoded<typeof CreateSpaceTaskAttachmentInputSchema> =>
  Schema.decodeUnknownEffect(CreateSpaceTaskAttachmentInputSchema)(value, strict)

export const encodeNewTaskRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(NewTaskInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify(input.body?.trim() === "" ? { ...input, body: null } : input)
    )
  )

export const encodeCreateLooseTaskRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(CreateLooseTaskInputSchema)(value, strict).pipe(
    Effect.map((input) =>
      JSON.stringify(input.body?.trim() === "" ? { ...input, body: null } : input)
    )
  )

export const encodeCreateSpaceTaskCommentRequestEffect = (value: unknown): EncodedText =>
  decodeCreateSpaceTaskCommentInputEffect(value).pipe(Effect.map(JSON.stringify))

export const encodeStopSpaceTaskRequestEffect = (value: unknown): EncodedText =>
  Schema.decodeUnknownEffect(StopSpaceTaskInputSchema)(value, strict).pipe(
    Effect.map(JSON.stringify)
  )

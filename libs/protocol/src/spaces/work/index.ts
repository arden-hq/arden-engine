import { decoderFor, makeEncoder, runBoundary } from "../../common/boundary.js"
import type { SpaceWorkPageOptions, SpaceTask } from "./contracts.js"
import type {
  AcknowledgeTaskResultInput,
  CreateChatTaskInput,
  CreateLooseTaskInput,
  CreateSpaceTaskAttachmentInput,
  CreateSpaceTaskCommentInput,
  MoveTaskToChatInput,
  NewTaskInput,
  TaskChange
} from "./input-contracts.js"
import {
  WorkOkResponseSchema,
  SpaceWorkPageSchema,
  SpaceTaskAttachmentSchema,
  SpaceTaskCommentSchema,
  SpaceTaskSchema,
  StopSpaceTaskResponseSchema,
  encodeCreateSpaceTaskAttachmentRequestEffect
} from "./schema.js"
import { encodeUpdateSpaceTaskRequestEffect } from "./change-schema.js"
import {
  encodeMoveTaskToChatEffect,
  encodeAcknowledgeTaskResultEffect,
  encodeCreateSpaceTaskCommentRequestEffect,
  encodeNewTaskRequestEffect,
  encodeCreateLooseTaskRequestEffect,
  encodeCreateChatTaskRequestEffect,
  encodeStopSpaceTaskRequestEffect
} from "./codecs.js"
import {
  encodeChatTaskPathEffect,
  encodeTaskChatPathEffect,
  encodeTaskResultReadPathEffect,
  encodeWorkAttachmentPathEffect,
  encodeWorkAttachmentUploadPathEffect,
  encodeWorkCollectionPathEffect,
  encodeWorkCommentPathEffect,
  encodeWorkItemPathEffect,
  encodeWorkPagePathEffect,
  encodeWorkStopPathEffect
} from "./routes.js"

export * from "./contracts.js"
export * from "./input-contracts.js"
export * from "./words.js"

export const workDecoders = {
  ok: decoderFor(WorkOkResponseSchema, "Invalid Work response"),
  task: decoderFor(SpaceTaskSchema, "Invalid Space task response"),
  stop: decoderFor(StopSpaceTaskResponseSchema, "Invalid Task stop response"),
  comment: decoderFor(SpaceTaskCommentSchema, "Invalid Space task comment response"),
  attachment: decoderFor(SpaceTaskAttachmentSchema, "Invalid Space task attachment response"),
  page: decoderFor(SpaceWorkPageSchema, "Invalid Work page response")
} as const

export const workRequests = {
  moveToChat: makeEncoder<MoveTaskToChatInput>(
    encodeMoveTaskToChatEffect,
    "Invalid Task move request"
  ),
  resultRead: makeEncoder<AcknowledgeTaskResultInput>(
    encodeAcknowledgeTaskResultEffect,
    "Invalid result-read request"
  ),
  create: makeEncoder<NewTaskInput>(encodeNewTaskRequestEffect, "Invalid create-work request"),
  createLoose: makeEncoder<CreateLooseTaskInput>(
    encodeCreateLooseTaskRequestEffect,
    "Invalid create-work request"
  ),
  createChatTask: makeEncoder<CreateChatTaskInput>(
    encodeCreateChatTaskRequestEffect,
    "Invalid chat Task request"
  ),
  comment: makeEncoder<CreateSpaceTaskCommentInput>(
    encodeCreateSpaceTaskCommentRequestEffect,
    "Invalid work-comment request"
  ),
  attachment: makeEncoder<CreateSpaceTaskAttachmentInput>(
    encodeCreateSpaceTaskAttachmentRequestEffect,
    "Invalid work-attachment request"
  ),
  update(currentTask: SpaceTask, changes: ReadonlyArray<TaskChange>): string {
    return runBoundary(
      encodeUpdateSpaceTaskRequestEffect({ expected_updated_at: currentTask.updated_at, changes }),
      "Invalid update-work request",
      "encode"
    )
  },
  stop(currentTask: SpaceTask): string {
    return runBoundary(
      encodeStopSpaceTaskRequestEffect({ expected_updated_at: currentTask.updated_at }),
      "Invalid Task stop request",
      "encode"
    )
  }
} as const

export const workRoutes = {
  taskChat(itemId: string): string {
    return runBoundary(encodeTaskChatPathEffect(itemId), "Invalid Task chat route", "encode")
  },
  resultRead(itemId: string): string {
    return runBoundary(
      encodeTaskResultReadPathEffect(itemId),
      "Invalid result-read route",
      "encode"
    )
  },
  chatTask(sessionId: string): string {
    return runBoundary(encodeChatTaskPathEffect(sessionId), "Invalid chat Task route", "encode")
  },
  page(options: SpaceWorkPageOptions): string {
    return runBoundary(encodeWorkPagePathEffect(options), "Invalid Work page route", "encode")
  },
  attachment(attachmentId: number): string {
    return runBoundary(
      encodeWorkAttachmentPathEffect(attachmentId),
      "Invalid work-attachment route",
      "encode"
    )
  },
  collection(spaceId: string): string {
    return runBoundary(
      encodeWorkCollectionPathEffect(spaceId),
      "Invalid Space-work route",
      "encode"
    )
  },
  looseCollection(): string {
    return "/spaces/work"
  },
  item(itemId: string): string {
    return runBoundary(encodeWorkItemPathEffect(itemId), "Invalid work-item route", "encode")
  },
  stop(itemId: string): string {
    return runBoundary(encodeWorkStopPathEffect(itemId), "Invalid Task stop route", "encode")
  },
  comment(itemId: string): string {
    return runBoundary(encodeWorkCommentPathEffect(itemId), "Invalid work-comment route", "encode")
  },
  attachmentUpload(itemId: string): string {
    return runBoundary(
      encodeWorkAttachmentUploadPathEffect(itemId),
      "Invalid work-attachment-upload route",
      "encode"
    )
  }
} as const

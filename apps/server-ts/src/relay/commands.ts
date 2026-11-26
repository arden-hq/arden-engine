import { COMMAND_ACK_STATE, COMMAND_KIND, type CommandAckState } from "@arden-hq/relay-protocol"
import { QUESTION_TEXT } from "@arden-hq/protocol/runs"
import {
  ANSWER_SHAPE,
  APPROVAL_REPLY,
  APPROVED_AS,
  ARGUMENT_EDITS,
  CANCEL_TARGET,
  CHAT_CAPTURE,
  DECISION_ASKED,
  FOLDER_ATTACH,
  RELAY_COMMAND,
  REQUESTED_MODE,
  SENT_FROM,
  STANDING_GRANT,
  TOOL_DECISION
} from "@arden-hq/protocol/chat"
import { Predicate, type Schema } from "effect"
import type { Loopback, LoopbackResponse } from "./ports.js"
import type { Command } from "./routes.js"

export type CommandOutcome = {
  readonly state: CommandAckState
  readonly result: Schema.Json | undefined
}

const ok = (response: LoopbackResponse): boolean => response.status >= 200 && response.status < 300

export const rejected = (message: string): CommandOutcome => ({
  state: COMMAND_ACK_STATE.rejected,
  result: { message }
})

const CHAT_MESSAGE_PATH = "/chat/message"

export const FALLBACK_FAILURE = "Your Mac couldn't do that."

export const failureMessage = (input: {
  readonly path: string
  readonly response: LoopbackResponse
}): string => {
  const body = input.response.body
  if (
    Predicate.isObject(body) &&
    "message" in body &&
    typeof body.message === "string" &&
    body.message.trim() !== ""
  )
    return body.message
  if (
    Predicate.isObject(body) &&
    "detail" in body &&
    typeof body.detail === "string" &&
    body.detail.trim() !== ""
  )
    return body.detail
  switch (input.response.status) {
    case 503:
      return input.path === CHAT_MESSAGE_PATH
        ? "Arden has no model set up on your Mac right now."
        : FALLBACK_FAILURE
    case 409:
      return "That was already handled."
    case 404:
      return "That's no longer there."
    default:
      return FALLBACK_FAILURE
  }
}

const replyList = (reply: Schema.Json | undefined): Schema.Json =>
  reply === undefined ? [] : [reply]

const messageBody = (input: {
  readonly sessionId: string
  readonly text: string
  readonly clientId: string
  readonly images: ReadonlyArray<{ readonly media_type: string; readonly data: string }> | undefined
  readonly replyTo: Schema.Json
  readonly capture: Schema.Json
}): Schema.Json => ({
  session_id: input.sessionId,
  message: input.text,
  client_id: input.clientId,
  images: (input.images ?? []).map((image) => ({
    type: "image",
    media_type: image.media_type,
    data: image.data
  })),
  reply_to: input.replyTo,
  approval_reply: { kind: APPROVAL_REPLY.none },
  approval_mode: { kind: REQUESTED_MODE.current },
  sent_from: { kind: SENT_FROM.typed },
  capture: input.capture,
  output_schema: { kind: ANSWER_SHAPE.free }
})

interface Call {
  readonly path: string
  readonly response: LoopbackResponse
}

const refusal = (call: Call): CommandOutcome => rejected(failureMessage(call))

const settled = (call: Call): CommandOutcome =>
  ok(call.response) ? { state: "done", result: call.response.body } : refusal(call)

export const runCommand = async (
  loopback: Loopback,
  cid: string,
  command: Exclude<
    Command,
    { readonly kind: typeof COMMAND_KIND.register_push | typeof COMMAND_KIND.set_keep_awake }
  >
): Promise<CommandOutcome> => {
  const post = async (path: string, body: Schema.Json): Promise<Call> => ({
    path,
    response: await loopback.request({ method: "POST", path, body })
  })
  switch (command.kind) {
    case COMMAND_KIND.send:
      return settled(
        await post(
          CHAT_MESSAGE_PATH,
          messageBody({
            sessionId: command.args.session_id,
            text: command.args.text,
            clientId: cid,
            images: command.args.images,
            replyTo: replyList(command.args.reply_to),
            capture: { kind: CHAT_CAPTURE.none }
          })
        )
      )
    case COMMAND_KIND.answer: {
      const choice = command.args.option_id
      const choices = command.args.option_ids
      const words = command.args.text.trim()
      const answer = (() => {
        if (choices !== undefined)
          return {
            kind: "choices",
            choice_ids: choices,
            typed:
              words === ""
                ? { kind: QUESTION_TEXT.none }
                : { kind: QUESTION_TEXT.given, text: words }
          }
        if (choice === undefined || choice === null)
          return { kind: "text", text: command.args.text }
        return { kind: "choice", choice_id: choice }
      })()
      return settled(
        await post(`/chat/questions/${encodeURIComponent(command.args.question_id)}/answer`, {
          client_id: cid,
          answer
        })
      )
    }
    case COMMAND_KIND.decide:
      return settled(
        await post("/tools/result", {
          run_id: command.args.run_id,
          tool_id: command.args.tool_id,
          result: "",
          decision: command.args.approve
            ? {
                kind: TOOL_DECISION.approved,
                grant: { kind: STANDING_GRANT.once },
                folder: FOLDER_ATTACH.keep,
                edits: { kind: ARGUMENT_EDITS.asAsked },
                as: APPROVED_AS.asAsked
              }
            : { kind: TOOL_DECISION.denied, grant: { kind: STANDING_GRANT.once } },
          asked:
            command.args.asked_at === undefined
              ? { kind: DECISION_ASKED.unstated }
              : { kind: DECISION_ASKED.at, at: command.args.asked_at },
          command: { kind: RELAY_COMMAND.command, id: cid }
        })
      )
    case COMMAND_KIND.stop: {
      const call = await post("/cancel", {
        kind: CANCEL_TARGET.session,
        session_id: command.args.session_id,
        hold_queue: false
      })
      if (ok(call.response))
        return { state: COMMAND_ACK_STATE.stopping, result: call.response.body }
      return call.response.status === 404
        ? { state: COMMAND_ACK_STATE.done, result: null }
        : refusal(call)
    }
    case COMMAND_KIND.capture: {
      const created = await post("/sessions", { space_id: command.args.space_id ?? null })
      const body = created.response.body
      const sessionId =
        ok(created.response) && Predicate.isObject(body) && "session_id" in body
          ? body.session_id
          : undefined
      if (typeof sessionId !== "string") return refusal(created)
      const sent = await post(
        CHAT_MESSAGE_PATH,
        messageBody({
          sessionId,
          text: command.args.text,
          clientId: cid,
          images: command.args.images,
          replyTo: [],
          capture: { kind: CHAT_CAPTURE.capture, via: "phone" }
        })
      )
      return ok(sent.response)
        ? { state: COMMAND_ACK_STATE.done, result: { session_id: sessionId } }
        : refusal(sent)
    }
  }
}

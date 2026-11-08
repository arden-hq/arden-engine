import type { CommandAckMessage } from "@arden-hq/relay-protocol"
import { Predicate, type Schema } from "effect"
import type { Loopback, LoopbackResponse } from "./ports.js"
import type { Command } from "./routes.js"

export type CommandOutcome = {
  readonly state: CommandAckMessage["state"]
  readonly result: Schema.Json | undefined
}

const ok = (response: LoopbackResponse): boolean => response.status >= 200 && response.status < 300

export const rejected = (message: string): CommandOutcome => ({
  state: "rejected",
  result: { message }
})

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
  switch (input.response.status) {
    case 503:
      return input.path === "/chat/message"
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

const withImages = (
  images: ReadonlyArray<{ readonly media_type: string; readonly data: string }> | undefined
): { images?: Schema.Json } =>
  images === undefined || images.length === 0
    ? {}
    : {
        images: images.map((image) => ({
          type: "image",
          media_type: image.media_type,
          data: image.data
        }))
      }

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
  command: Exclude<Command, { readonly kind: "register_push" | "set_keep_awake" }>
): Promise<CommandOutcome> => {
  const post = async (path: string, body: Schema.Json): Promise<Call> => ({
    path,
    response: await loopback.request({ method: "POST", path, body })
  })
  switch (command.kind) {
    case "send":
      return settled(
        await post("/chat/message", {
          session_id: command.args.session_id,
          message: command.args.text,
          client_id: cid,
          ...withImages(command.args.images),
          ...(command.args.reply_to === undefined ? {} : { reply_to: command.args.reply_to })
        })
      )
    case "answer": {
      const choice = command.args.option_id
      const choices = command.args.option_ids
      const words = command.args.text.trim()
      const answer = (() => {
        if (choices !== undefined)
          return { kind: "choices", choice_ids: choices, ...(words === "" ? {} : { text: words }) }
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
    case "decide":
      return settled(
        await post("/tools/result", {
          run_id: command.args.run_id,
          tool_id: command.args.tool_id,
          result: "",
          approved: command.args.approve
        })
      )
    case "stop": {
      const call = await post("/cancel", { session_id: command.args.session_id })
      if (ok(call.response)) return { state: "stopping", result: call.response.body }
      return call.response.status === 404 ? { state: "done", result: null } : refusal(call)
    }
    case "capture": {
      const created = await post("/sessions", { space_id: command.args.space_id ?? null })
      const body = created.response.body
      const sessionId =
        ok(created.response) && Predicate.isObject(body) && "session_id" in body
          ? body.session_id
          : undefined
      if (typeof sessionId !== "string") return refusal(created)
      const sent = await post("/chat/message", {
        session_id: sessionId,
        message: command.args.text,
        client_id: cid,
        capture: "phone",
        ...withImages(command.args.images)
      })
      return ok(sent.response)
        ? { state: "done", result: { session_id: sessionId } }
        : refusal(sent)
    }
  }
}

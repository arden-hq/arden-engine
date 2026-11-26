import { after, type Timer } from "@arden-hq/std/timer"
import {
  APP_MESSAGE_TAG,
  COMMAND_ACK_STATE,
  COMMAND_KIND,
  type CommandMessage,
  type HttpMethod,
  type MacMessage,
  type PhoneMessage
} from "@arden-hq/relay-protocol"
import {
  FALLBACK_FAILURE,
  failureMessage,
  rejected,
  runCommand,
  type CommandOutcome
} from "./commands.js"
import { RELAY_COMMAND_STATE, type PushTarget } from "../persistence/relay/store.js"
import type { CommandLog, Loopback, LoopbackResponse, RelayLog } from "./ports.js"
import { allowedRequest, allowedStream, decodeCommand } from "./routes.js"
import { RelayStream } from "./stream.js"
import { currentMillis } from "../runtime/clock.js"
import { errorMessage } from "@arden-hq/std/errors"

const PhoneLimits = {
  streams: 8,
  graceMs: 10 * 60_000,
  commandTtlMs: 24 * 60 * 60_000
} as const

type Sink = (message: MacMessage) => void

export class PhoneSession {
  readonly dev: string
  readonly #loopback: Loopback
  readonly #commands: CommandLog
  readonly #log: RelayLog
  readonly #registerPush: (push: PushTarget) => Promise<void>
  readonly #setKeepAwake: (on: boolean) => Promise<void>
  readonly #streams = new Map<string, RelayStream>()
  readonly #requests = new Map<string, AbortController>()
  readonly #running = new Set<string>()
  #sink: Sink | undefined
  #grace: Timer | undefined

  constructor(options: {
    readonly dev: string
    readonly loopback: Loopback
    readonly commands: CommandLog
    readonly log: RelayLog
    readonly registerPush: (push: PushTarget) => Promise<void>
    readonly setKeepAwake: (on: boolean) => Promise<void>
  }) {
    this.dev = options.dev
    this.#loopback = options.loopback
    this.#commands = options.commands
    this.#log = options.log
    this.#registerPush = options.registerPush
    this.#setKeepAwake = options.setKeepAwake
  }

  attach(sink: Sink): void {
    this.#grace?.cancel()
    this.#grace = undefined
    this.#sink = sink
  }

  detach(): void {
    this.#sink = undefined
    for (const stream of this.#streams.values()) stream.detach()
    for (const request of this.#requests.values()) request.abort()
    this.#requests.clear()
    this.#grace?.cancel()
    this.#grace = after(PhoneLimits.graceMs, () => this.#closeStreams(), { unref: true })
  }

  close(): void {
    this.detach()
    this.#grace?.cancel()
    this.#closeStreams()
  }

  handle(message: PhoneMessage): void {
    switch (message.t) {
      case APP_MESSAGE_TAG.resume:
        for (const [sid, stream] of this.#streams) {
          if (!(sid in message.streams)) {
            stream.close()
            this.#streams.delete(sid)
          }
        }
        for (const cid of message.pending) void this.#reack(cid)
        return
      case APP_MESSAGE_TAG.req:
        void this.#request(message.rid, message.method, message.path)
        return
      case APP_MESSAGE_TAG.cancel:
        this.#requests.get(message.rid)?.abort()
        this.#requests.delete(message.rid)
        return
      case APP_MESSAGE_TAG.sub:
        this.#subscribe(message.sid, message.path, message.from_seq)
        return
      case APP_MESSAGE_TAG.unsub:
        this.#streams.get(message.sid)?.close()
        this.#streams.delete(message.sid)
        return
      case APP_MESSAGE_TAG.ack:
        this.#streams.get(message.sid)?.ack(message.seq)
        return
      case APP_MESSAGE_TAG.cmd:
        void this.command(message)
        return
    }
  }

  async command(message: CommandMessage): Promise<void> {
    if (this.#running.has(message.cid)) return
    if (currentMillis() - message.ts > PhoneLimits.commandTtlMs) {
      this.#ack(message.cid, rejected("This waited too long and was not sent."))
      return
    }
    const command = decodeCommand(message.kind, message.args)
    if (command === undefined) {
      this.#ack(message.cid, rejected("Arden could not read that."))
      return
    }
    if (command.kind === COMMAND_KIND.register_push) {
      await this.#registerPush({
        token: command.args.token.toLowerCase(),
        env: command.args.environment,
        topic: command.args.topic
      })
      this.#ack(message.cid, { state: COMMAND_ACK_STATE.done, result: null })
      return
    }
    if (command.kind === COMMAND_KIND.set_keep_awake) {
      await this.#setKeepAwake(command.args.on)
      this.#ack(message.cid, { state: COMMAND_ACK_STATE.done, result: null })
      return
    }
    this.#running.add(message.cid)
    try {
      const known = await this.#commands.begin({ cid: message.cid, kind: message.kind })
      if (known !== undefined && known.state !== RELAY_COMMAND_STATE.running) {
        this.#ack(message.cid, { state: known.state, result: known.result })
        return
      }
      const outcome = await runCommand(this.#loopback, message.cid, command).catch(
        (cause: unknown) => {
          this.#log("warning", "Phone command failed", {
            kind: message.kind,
            cause: errorMessage(cause)
          })
          return rejected(FALLBACK_FAILURE)
        }
      )
      await this.#commands.finish({
        cid: message.cid,
        state: outcome.state,
        result: outcome.result
      })
      const kept = await this.#commands.find(message.cid)
      this.#ack(
        message.cid,
        kept === undefined || kept.state === RELAY_COMMAND_STATE.running
          ? outcome
          : { state: kept.state, result: kept.result }
      )
    } finally {
      this.#running.delete(message.cid)
    }
  }

  async #reack(cid: string): Promise<void> {
    const known = await this.#commands.find(cid)
    if (known === undefined || known.state === RELAY_COMMAND_STATE.running) return
    this.#ack(cid, { state: known.state, result: known.result })
  }

  #ack(cid: string, outcome: CommandOutcome): void {
    this.#sink?.(
      outcome.result === undefined
        ? { t: "cmd_ack", cid, state: outcome.state }
        : { t: "cmd_ack", cid, state: outcome.state, result: outcome.result }
    )
  }

  async #request(rid: string, method: HttpMethod, path: string): Promise<void> {
    const allowed = allowedRequest(method, path)
    if (allowed === undefined) {
      this.#sink?.({ t: "res", rid, status: 403, body: { message: FALLBACK_FAILURE } })
      return
    }
    const controller = new AbortController()
    this.#requests.set(rid, controller)
    try {
      const response = await this.#loopback.request({ ...allowed, signal: controller.signal })
      if (!controller.signal.aborted)
        this.#sink?.({
          t: "res",
          rid,
          status: response.status,
          body: explained(allowed.path, response)
        })
    } catch {
      if (!controller.signal.aborted)
        this.#sink?.({ t: "res", rid, status: 502, body: { message: FALLBACK_FAILURE } })
    } finally {
      if (this.#requests.get(rid) === controller) this.#requests.delete(rid)
    }
  }

  #subscribe(sid: string, path: string, fromSeq: number | undefined): void {
    const sink = this.#sink
    if (sink === undefined) return
    const route = allowedStream(path)
    if (route === undefined) {
      sink({ t: "reset", sid, reason: "forbidden" })
      return
    }
    const existing = this.#streams.get(sid)
    if (existing !== undefined && existing.route.path === route.path) {
      existing.attach(sink, fromSeq)
      return
    }
    existing?.close()
    this.#streams.delete(sid)
    if (this.#streams.size >= PhoneLimits.streams) {
      sink({ t: "reset", sid, reason: "limit" })
      return
    }
    if (fromSeq !== undefined && fromSeq > 0) sink({ t: "reset", sid, reason: "gap" })
    const stream = new RelayStream({ sid, route, loopback: this.#loopback, log: this.#log })
    this.#streams.set(sid, stream)
    stream.attach(sink, undefined)
  }

  #closeStreams(): void {
    for (const stream of this.#streams.values()) stream.close()
    this.#streams.clear()
  }
}

const explained = (path: string, response: LoopbackResponse): LoopbackResponse["body"] =>
  response.status >= 200 && response.status < 300
    ? response.body
    : { message: failureMessage({ path: path.split("?")[0] ?? path, response }) }

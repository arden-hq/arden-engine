import type {
  ComputerApp,
  ComputerFeedback,
  ComputerFrameCapture,
  ComputerMode,
  ComputerOperation,
  ComputerPreview,
  ComputerSession,
  ComputerStatus
} from "@arden-hq/protocol/computer"
import {
  COMPUTER_ACTIVITY,
  COMPUTER_APP,
  COMPUTER_FEEDBACK,
  COMPUTER_MODE,
  COMPUTER_OPERATION,
  COMPUTER_PREVIEW,
  COMPUTER_SESSION
} from "@arden-hq/protocol/computer"

const SURFACE = { desktop: "desktop", window: "window" } as const
const UNCLAIMED: ComputerSession = { kind: COMPUTER_SESSION.unclaimed }
const UNIDENTIFIED: ComputerApp = { kind: COMPUTER_APP.unidentified }
const UNLABELLED: ComputerOperation = { kind: COMPUTER_OPERATION.unlabelled }
const EMPTY: ComputerPreview = { kind: COMPUTER_PREVIEW.empty }

export type ComputerSurface =
  | { readonly kind: typeof SURFACE.desktop }
  | { readonly kind: typeof SURFACE.window; readonly id: string }

type LabelledOperation = Extract<ComputerOperation, { kind: typeof COMPUTER_OPERATION.labelled }>

export const DESKTOP: ComputerSurface = { kind: SURFACE.desktop }
export const windowSurface = (target: {
  readonly pid: number
  readonly window_id: number
}): ComputerSurface => ({ kind: SURFACE.window, id: `${target.pid}:${target.window_id}` })
export const labelled = (
  label: string,
  delivery: LabelledOperation["delivery"],
  feedback: ComputerFeedback = { kind: COMPUTER_FEEDBACK.unlocated }
): LabelledOperation => ({ kind: COMPUTER_OPERATION.labelled, label, delivery, feedback })

const sameSurface = (left: ComputerSurface, right: ComputerSurface): boolean =>
  left.kind === SURFACE.desktop
    ? right.kind === SURFACE.desktop
    : right.kind === SURFACE.window && left.id === right.id

export class ComputerControl {
  #epoch = new AbortController()
  #generation = 0
  #foregroundSession: string | undefined

  get generation(): number {
    return this.#generation
  }

  identify(target: string, application: ComputerApp): void {
    if (this.#active === undefined || this.#session.kind === COMPUTER_SESSION.unclaimed) return
    this.#session = { ...this.#session, target, application }
  }
  #session: ComputerSession = UNCLAIMED
  #preview: ComputerPreview = EMPTY
  #surface: ComputerSurface = DESKTOP

  preview(): ComputerPreview {
    return this.#preview
  }

  capture({
    sessionId,
    surface,
    frame
  }: {
    sessionId: string
    surface: string
    frame: ComputerFrameCapture
  }): void {
    if (
      this.#active === undefined ||
      this.#session.kind === COMPUTER_SESSION.unclaimed ||
      this.#session.session_id !== sessionId ||
      !sameSurface(this.#surface, { kind: "window", id: surface })
    )
      return
    this.#preview = { kind: COMPUTER_PREVIEW.captured, ...frame }
    this.#session = {
      ...this.#session,
      preview: {
        kind: COMPUTER_PREVIEW.captured,
        id: frame.id,
        captured_at: frame.captured_at,
        surface
      }
    }
  }

  #mode: ComputerMode = COMPUTER_MODE.ready
  #active: object | undefined
  #activity: ComputerStatus["activity"] = "idle"

  status(): ComputerStatus {
    return {
      mode: this.#mode,
      foreground_allowed:
        this.#foregroundSession !== undefined &&
        this.#session.kind === COMPUTER_SESSION.claimed &&
        this.#foregroundSession === this.#session.session_id,
      session: this.#session,
      activity: this.#activity
    }
  }

  signal(signal: AbortSignal): AbortSignal {
    if (this.#mode === COMPUTER_MODE.paused)
      throw new Error("Computer control paused by the user. Wait for them to resume it in Arden.")
    return AbortSignal.any([signal, this.#epoch.signal])
  }

  begin({
    target,
    activity,
    signal,
    sessionId,
    surface,
    operation
  }: {
    target: string
    activity: "observing" | "acting"
    signal: AbortSignal
    sessionId: string
    surface: ComputerSurface
    operation: LabelledOperation
  }): () => void {
    signal.throwIfAborted()
    if (this.#mode === COMPUTER_MODE.paused) throw new Error("Computer control paused by the user")
    const token = {}
    const previous = this.#session
    const same =
      previous.kind === COMPUTER_SESSION.claimed &&
      previous.session_id === sessionId &&
      sameSurface(this.#surface, surface)
    if (!same) this.#preview = EMPTY
    this.#surface = surface
    const kept: Extract<ComputerSession, { kind: "claimed" }> =
      same && previous.kind === COMPUTER_SESSION.claimed
        ? previous
        : {
            kind: "claimed",
            session_id: sessionId,
            target,
            application: UNIDENTIFIED,
            operation: UNLABELLED,
            preview: { kind: COMPUTER_PREVIEW.empty }
          }
    const replace =
      !same ||
      activity === COMPUTER_ACTIVITY.acting ||
      kept.operation.kind === COMPUTER_OPERATION.unlabelled
    this.#active = token
    if (previous.kind === COMPUTER_SESSION.unclaimed || previous.session_id !== sessionId)
      this.#foregroundSession = undefined
    this.#session = {
      ...kept,
      operation: replace
        ? {
            ...operation,
            feedback:
              operation.feedback.kind === COMPUTER_FEEDBACK.unlocated &&
              same &&
              kept.operation.kind === COMPUTER_OPERATION.labelled
                ? kept.operation.feedback
                : operation.feedback
          }
        : kept.operation
    }
    this.#activity = activity
    return () => {
      if (this.#active !== token) return
      this.#active = undefined
      this.#activity = "idle"
    }
  }

  allowForeground(sessionId: string): boolean {
    if (
      this.#mode === COMPUTER_MODE.paused ||
      this.#session.kind === COMPUTER_SESSION.unclaimed ||
      this.#session.session_id !== sessionId
    )
      return false
    this.#foregroundSession = sessionId
    return true
  }

  foregroundAllowed(sessionId: string): boolean {
    return this.#mode === COMPUTER_MODE.ready && this.#foregroundSession === sessionId
  }

  requireForeground(sessionId: string): void {
    if (this.#mode === COMPUTER_MODE.ready && this.#foregroundSession === sessionId) return
    if (this.#session.kind === COMPUTER_SESSION.claimed)
      this.#session = {
        ...this.#session,
        operation: {
          kind: "labelled",
          label: "Waiting for foreground access",
          delivery: "foreground",
          feedback: { kind: "unlocated" }
        }
      }
    throw new Error(
      "Foreground input is not allowed yet. Continue with background control or a non-activating app API. If foreground is essential, call computer_act directly (not inside a computer script): the user is asked on a card and can allow it for this chat. Do not bypass this with shell, AppleScript activation, or another input tool."
    )
  }

  pause(): void {
    this.#foregroundSession = undefined
    this.#generation++
    this.#mode = COMPUTER_MODE.paused
    this.#epoch.abort(
      new Error("Computer control taken over by the user; reacquire and observe after they resume")
    )
    this.#active = undefined
    this.#activity = "idle"
  }

  resume(): void {
    if (this.#mode !== COMPUTER_MODE.paused) return
    this.#epoch = new AbortController()
    this.#mode = COMPUTER_MODE.ready
    this.#session = UNCLAIMED
    this.#preview = EMPTY
    this.#surface = { kind: "desktop" }
  }
}

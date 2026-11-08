import type { ComputerStatus, ComputerPreview } from "@arden-hq/protocol/computer"

export class ComputerControl {
  #epoch = new AbortController()
  #generation = 0
  #foregroundSession: string | undefined

  get generation(): number {
    return this.#generation
  }

  identify(target: string, application: ComputerStatus["application"]): void {
    if (this.#active === undefined) return
    this.#target = target
    this.#application = application
  }
  #application: ComputerStatus["application"] = null
  #operation: ComputerStatus["operation"] = null
  #preview: ComputerPreview | null = null
  #surface: string | null = null

  preview(): ComputerPreview | null {
    return this.#preview
  }

  capture({
    sessionId,
    surface,
    frame
  }: {
    sessionId: string
    surface: string
    frame: ComputerPreview
  }): void {
    if (this.#active === undefined || this.#sessionId !== sessionId || this.#surface !== surface)
      return
    this.#preview = frame
  }

  #mode: ComputerStatus["mode"] = "ready"
  #sessionId: string | null = null
  #target: string | null = null
  #active: object | undefined
  #activity: ComputerStatus["activity"] = "idle"

  status(): ComputerStatus {
    return {
      mode: this.#mode,
      foreground_allowed:
        this.#foregroundSession !== undefined && this.#foregroundSession === this.#sessionId,
      session_id: this.#sessionId,
      target: this.#target,
      application: this.#application,
      operation: this.#operation,
      preview:
        this.#preview === null || this.#surface === null
          ? null
          : {
              id: this.#preview.id,
              captured_at: this.#preview.captured_at,
              surface: this.#surface
            },
      activity: this.#activity
    }
  }

  signal(signal: AbortSignal): AbortSignal {
    if (this.#mode === "paused")
      throw new Error("Computer control paused by the user. Wait for them to resume it in Arden.")
    return AbortSignal.any([signal, this.#epoch.signal])
  }

  begin({
    target,
    activity,
    signal,
    sessionId,
    surface = null,
    operation = null
  }: {
    target: string
    activity: "observing" | "acting"
    signal: AbortSignal
    sessionId: string
    surface?: string | null
    operation?: ComputerStatus["operation"]
  }): () => void {
    signal.throwIfAborted()
    if (this.#mode === "paused") throw new Error("Computer control paused by the user")
    const token = {}
    const sameWindow = this.#sessionId === sessionId && this.#surface === surface
    if (!sameWindow) {
      this.#preview = null
      this.#application = null
    }
    this.#surface = surface
    if (!sameWindow || activity === "acting" || this.#operation === null) {
      this.#operation =
        operation === null
          ? null
          : {
              ...operation,
              feedback:
                operation.feedback ?? (sameWindow ? (this.#operation?.feedback ?? null) : null)
            }
    }
    this.#active = token
    if (this.#sessionId !== sessionId) this.#foregroundSession = undefined
    this.#sessionId = sessionId
    if (!sameWindow || this.#target === null) this.#target = target
    this.#activity = activity
    return () => {
      if (this.#active !== token) return
      this.#active = undefined
      this.#activity = "idle"
    }
  }

  allowForeground(sessionId: string): boolean {
    if (this.#mode === "paused" || this.#sessionId !== sessionId) return false
    this.#foregroundSession = sessionId
    return true
  }

  foregroundAllowed(sessionId: string): boolean {
    return this.#mode === "ready" && this.#foregroundSession === sessionId
  }

  requireForeground(sessionId: string): void {
    if (this.#mode === "ready" && this.#foregroundSession === sessionId) return
    this.#operation = {
      label: "Waiting for foreground access",
      delivery: "foreground",
      feedback: null
    }
    throw new Error(
      "Foreground input is not allowed yet. Continue with background control or a non-activating app API. If foreground is essential, call computer_act directly (not inside a computer script): the user is asked on a card and can allow it for this chat. Do not bypass this with shell, AppleScript activation, or another input tool."
    )
  }

  pause(): void {
    this.#foregroundSession = undefined
    this.#generation++
    this.#mode = "paused"
    this.#epoch.abort(
      new Error("Computer control taken over by the user; reacquire and observe after they resume")
    )
    this.#active = undefined
    this.#activity = "idle"
  }

  resume(): void {
    if (this.#mode !== "paused") return
    this.#epoch = new AbortController()
    this.#mode = "ready"
    this.#operation = null
    this.#preview = null
    this.#surface = null
    this.#sessionId = null
    this.#target = null
    this.#application = null
  }
}

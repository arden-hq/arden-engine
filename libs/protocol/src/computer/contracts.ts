/** Managed helper setup is independent of the user's takeover state. */
export interface ComputerSetup {
  readonly version: string
  readonly permissions:
    | { readonly kind: "idle" | "running" | "granted" }
    | { readonly kind: "failed"; readonly message: string }
  readonly installation:
    | { readonly kind: "unsupported" }
    | { readonly kind: "disabled" }
    | { readonly kind: "downloading"; readonly receivedBytes: number; readonly totalBytes: number }
    | { readonly kind: "verifying" }
    | { readonly kind: "waiting" }
    | { readonly kind: "installed" }
    | { readonly kind: "failed"; readonly message: string }
}

export type ComputerFeedback = {
  readonly id: string
  readonly frame: { readonly width: number; readonly height: number }
} & (
  | { readonly kind: "pointer"; readonly x: number; readonly y: number }
  | {
      readonly kind: "target"
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
)

export interface ComputerStatus {
  readonly mode: "ready" | "paused"
  readonly foreground_allowed: boolean
  readonly session_id: string | null
  readonly application: { readonly name: string; readonly icon: string } | null
  readonly target: string | null
  readonly operation: {
    readonly label: string
    readonly delivery: "background" | "foreground" | null
    /** Last located input on this window; keyboard actions do not move it. */
    readonly feedback: ComputerFeedback | null
  } | null
  readonly preview: {
    readonly id: string
    readonly captured_at: number
    readonly surface: string
  } | null
  readonly activity: "idle" | "observing" | "acting"
}

export interface ComputerPreview {
  readonly id: string
  readonly session_id: string
  readonly captured_at: number
  readonly data_url: string
  readonly width: number
  readonly height: number
}

/**
 * What one computer call did, in words a chat row can show, carried in the
 * call's result data as `computer`. `look` observed a window; `act` changed
 * something in it. `title` is the whole row ("Replaced text in TextEdit").
 */
export interface ComputerStep {
  readonly kind: "look" | "act"
  readonly title: string
  readonly app: { readonly name: string; readonly icon: string } | null
  readonly window: string | null
  /** Window pictures this step saw, in order, each captioned with what led
   *  to it. Identical pictures are kept once; none while the user has control. */
  readonly frames: ReadonlyArray<ComputerFrame>
}

/** One window picture of a replay: a small PNG data URL. */
export interface ComputerFrame {
  readonly image: string
  readonly width: number
  readonly height: number
  readonly caption: string
}

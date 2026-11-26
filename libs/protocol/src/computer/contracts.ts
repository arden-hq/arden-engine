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

export const COMPUTER_APP = { unidentified: "unidentified", identified: "identified" } as const
export const COMPUTER_FEEDBACK = {
  unlocated: "unlocated",
  pointer: "pointer",
  target: "target"
} as const
export const COMPUTER_OPERATION = { unlabelled: "unlabelled", labelled: "labelled" } as const
export const COMPUTER_PREVIEW = { empty: "empty", captured: "captured" } as const
export const COMPUTER_SESSION = { unclaimed: "unclaimed", claimed: "claimed" } as const

export type ComputerApp =
  | { readonly kind: "unidentified" }
  | { readonly kind: "identified"; readonly name: string; readonly icon: string }

export type ComputerFeedback =
  | { readonly kind: "unlocated" }
  | {
      readonly kind: "pointer"
      readonly id: string
      readonly frame: { readonly width: number; readonly height: number }
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: "target"
      readonly id: string
      readonly frame: { readonly width: number; readonly height: number }
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }

export type ComputerOperation =
  | { readonly kind: "unlabelled" }
  | {
      readonly kind: "labelled"
      readonly label: string
      readonly delivery: "none" | "background" | "foreground"
      readonly feedback: ComputerFeedback
    }

export type ComputerPreviewRef =
  | { readonly kind: "empty" }
  | {
      readonly kind: "captured"
      readonly id: string
      readonly captured_at: number
      readonly surface: string
    }

export type ComputerSession =
  | { readonly kind: "unclaimed" }
  | {
      readonly kind: "claimed"
      readonly session_id: string
      readonly target: string
      readonly application: ComputerApp
      readonly operation: ComputerOperation
      readonly preview: ComputerPreviewRef
    }

export interface ComputerStatus {
  readonly mode: "ready" | "paused"
  readonly foreground_allowed: boolean
  readonly session: ComputerSession
  readonly activity: "idle" | "observing" | "acting"
}

export interface ComputerFrameCapture {
  readonly id: string
  readonly session_id: string
  readonly captured_at: number
  readonly data_url: string
  readonly width: number
  readonly height: number
}

export type ComputerPreview =
  | { readonly kind: "empty" }
  | ({ readonly kind: "captured" } & ComputerFrameCapture)

export type ComputerWindow =
  | { readonly kind: "untitled" }
  | { readonly kind: "titled"; readonly title: string }

export interface ComputerStep {
  readonly kind: "look" | "act"
  readonly title: string
  readonly app: ComputerApp
  readonly window: ComputerWindow
  readonly frames: ReadonlyArray<ComputerFrame>
}

export interface ComputerFrame {
  readonly image: string
  readonly width: number
  readonly height: number
  readonly caption: string
}

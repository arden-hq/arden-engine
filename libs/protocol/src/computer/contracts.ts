export const COMPUTER_PERMISSIONS = {
  idle: "idle",
  running: "running",
  granted: "granted",
  failed: "failed"
} as const

export type ComputerPermissions =
  | {
      readonly kind:
        | typeof COMPUTER_PERMISSIONS.idle
        | typeof COMPUTER_PERMISSIONS.running
        | typeof COMPUTER_PERMISSIONS.granted
    }
  | { readonly kind: typeof COMPUTER_PERMISSIONS.failed; readonly message: string }

export const COMPUTER_INSTALLATION = {
  unsupported: "unsupported",
  disabled: "disabled",
  downloading: "downloading",
  verifying: "verifying",
  waiting: "waiting",
  installed: "installed",
  failed: "failed"
} as const

export type ComputerInstallation =
  | { readonly kind: typeof COMPUTER_INSTALLATION.unsupported }
  | { readonly kind: typeof COMPUTER_INSTALLATION.disabled }
  | {
      readonly kind: typeof COMPUTER_INSTALLATION.downloading
      readonly receivedBytes: number
      readonly totalBytes: number
    }
  | { readonly kind: typeof COMPUTER_INSTALLATION.verifying }
  | { readonly kind: typeof COMPUTER_INSTALLATION.waiting }
  | { readonly kind: typeof COMPUTER_INSTALLATION.installed }
  | { readonly kind: typeof COMPUTER_INSTALLATION.failed; readonly message: string }

export interface ComputerSetup {
  readonly version: string
  readonly permissions: ComputerPermissions
  readonly installation: ComputerInstallation
}

export const COMPUTER_APP = { unidentified: "unidentified", identified: "identified" } as const

export type ComputerApp =
  | { readonly kind: typeof COMPUTER_APP.unidentified }
  | { readonly kind: typeof COMPUTER_APP.identified; readonly name: string; readonly icon: string }

export const COMPUTER_FEEDBACK = {
  unlocated: "unlocated",
  pointer: "pointer",
  target: "target"
} as const

export type ComputerFeedback =
  | { readonly kind: typeof COMPUTER_FEEDBACK.unlocated }
  | {
      readonly kind: typeof COMPUTER_FEEDBACK.pointer
      readonly id: string
      readonly frame: { readonly width: number; readonly height: number }
      readonly x: number
      readonly y: number
    }
  | {
      readonly kind: typeof COMPUTER_FEEDBACK.target
      readonly id: string
      readonly frame: { readonly width: number; readonly height: number }
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }

export const COMPUTER_DELIVERY = {
  none: "none",
  background: "background",
  foreground: "foreground"
} as const

export type ComputerDelivery = (typeof COMPUTER_DELIVERY)[keyof typeof COMPUTER_DELIVERY]

export const COMPUTER_OPERATION = { unlabelled: "unlabelled", labelled: "labelled" } as const

export type ComputerOperation =
  | { readonly kind: typeof COMPUTER_OPERATION.unlabelled }
  | {
      readonly kind: typeof COMPUTER_OPERATION.labelled
      readonly label: string
      readonly delivery: ComputerDelivery
      readonly feedback: ComputerFeedback
    }

export const COMPUTER_PREVIEW = { empty: "empty", captured: "captured" } as const

export type ComputerPreviewRef =
  | { readonly kind: typeof COMPUTER_PREVIEW.empty }
  | {
      readonly kind: typeof COMPUTER_PREVIEW.captured
      readonly id: string
      readonly captured_at: number
      readonly surface: string
    }

export const COMPUTER_SESSION = { unclaimed: "unclaimed", claimed: "claimed" } as const

export type ComputerSession =
  | { readonly kind: typeof COMPUTER_SESSION.unclaimed }
  | {
      readonly kind: typeof COMPUTER_SESSION.claimed
      readonly session_id: string
      readonly target: string
      readonly application: ComputerApp
      readonly operation: ComputerOperation
      readonly preview: ComputerPreviewRef
    }

export const COMPUTER_MODE = { ready: "ready", paused: "paused" } as const

export type ComputerMode = (typeof COMPUTER_MODE)[keyof typeof COMPUTER_MODE]

export const COMPUTER_ACTIVITY = { idle: "idle", observing: "observing", acting: "acting" } as const

export type ComputerActivity = (typeof COMPUTER_ACTIVITY)[keyof typeof COMPUTER_ACTIVITY]

export interface ComputerStatus {
  readonly mode: ComputerMode
  readonly foreground_allowed: boolean
  readonly session: ComputerSession
  readonly activity: ComputerActivity
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
  | { readonly kind: typeof COMPUTER_PREVIEW.empty }
  | ({ readonly kind: typeof COMPUTER_PREVIEW.captured } & ComputerFrameCapture)

export const COMPUTER_WINDOW = { untitled: "untitled", titled: "titled" } as const

export type ComputerWindow =
  | { readonly kind: typeof COMPUTER_WINDOW.untitled }
  | { readonly kind: typeof COMPUTER_WINDOW.titled; readonly title: string }

export const COMPUTER_STEP = { look: "look", act: "act" } as const

export type ComputerStepKind = (typeof COMPUTER_STEP)[keyof typeof COMPUTER_STEP]

export interface ComputerStep {
  readonly kind: ComputerStepKind
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

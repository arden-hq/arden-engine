import type { Role } from "@arden-hq/relay-protocol"

export const ATTACHMENT_STATE = {
  challenged: "challenged",
  pairing: "pairing",
  authed: "authed",
  closed: "closed"
} as const

export type Attachment =
  | {
      readonly state: typeof ATTACHMENT_STATE.challenged
      readonly nonce: string
      readonly opened: number
    }
  | {
      readonly state: typeof ATTACHMENT_STATE.pairing
      readonly dev: string
      readonly opened: number
    }
  | {
      readonly state: typeof ATTACHMENT_STATE.authed
      readonly role: Role
      readonly dev: string
      readonly heard: number
    }
  | { readonly state: typeof ATTACHMENT_STATE.closed }

export interface Conns<S> {
  send(socket: S, frame: Uint8Array): void
  close(socket: S, code: number, reason: string): void
  sockets(): readonly S[]
  attachment(socket: S): Attachment | undefined
  setAttachment(socket: S, attachment: Attachment): void
  lastPing(socket: S): number | undefined
}

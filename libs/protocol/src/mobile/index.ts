import { decoderFor } from "../common/boundary.js"
import {
  MobileConversationSchema,
  MobileSpacesSchema,
  MobileHomeSchema,
  MobileTurnSchema
} from "./schema.js"

export type {
  MobileAsk,
  MobileChange,
  MobileConversation,
  MobileConversationItem,
  MobileSpaces,
  MobileHome,
  MobileLetter,
  MobileLink,
  MobileStateLine,
  MobileTurn,
  MobileTurnStep
} from "./schema.js"

export const mobileDecoders = {
  home: decoderFor(MobileHomeSchema, "Invalid phone Home"),
  spaces: decoderFor(MobileSpacesSchema, "Invalid phone Spaces"),
  conversation: decoderFor(MobileConversationSchema, "Invalid phone conversation"),
  turn: decoderFor(MobileTurnSchema, "Invalid phone turn")
} as const

export const mobileRoutes = {
  home: "/mobile/home",
  spaces: "/mobile/spaces",
  conversation: (sessionId: string, before?: string): string =>
    `/mobile/sessions/${encodeURIComponent(sessionId)}/conversation${
      before === undefined ? "" : `?before=${encodeURIComponent(before)}`
    }`,
  turn: (sessionId: string, turnId: string): string =>
    `/mobile/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`
} as const

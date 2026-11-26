import { decoderFor } from "../common/boundary.js"
import { MobileConversationSchema, MobileSpacesSchema, MobileHomeSchema } from "./schema.js"

export {
  MOBILE_ASK,
  MOBILE_CHANGE,
  MOBILE_CHAT_LINK,
  MOBILE_CONVERSATION_ITEM,
  MOBILE_DIFF_LINE,
  MOBILE_FILING,
  MOBILE_LINK
} from "./schema.js"

export type {
  MobileAsk,
  MobileChange,
  MobileChatLink,
  MobileDetail,
  MobileFiling,
  MobileConversation,
  MobileConversationItem,
  MobileSpaces,
  MobileHome,
  MobileLetter,
  MobileLink,
  MobileStateLine
} from "./schema.js"

export const mobileDecoders = {
  home: decoderFor(MobileHomeSchema, "Invalid phone Home"),
  spaces: decoderFor(MobileSpacesSchema, "Invalid phone Spaces"),
  conversation: decoderFor(MobileConversationSchema, "Invalid phone conversation")
} as const

export const mobileRoutes = {
  home: "/mobile/home",
  spaces: "/mobile/spaces",
  conversation: (sessionId: string, before?: string): string =>
    `/mobile/sessions/${encodeURIComponent(sessionId)}/conversation${
      before === undefined ? "" : `?before=${encodeURIComponent(before)}`
    }`
} as const

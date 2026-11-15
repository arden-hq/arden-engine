const CHAT_LINK = "arden:session/"

/** The link to a chat, or to one turn of it: the one place a chat link is built. */
export const chatHref = (chat: { readonly publicRef: string; readonly turnId?: string }): string =>
  `${CHAT_LINK}${encodeURIComponent(chat.publicRef)}${chat.turnId === undefined ? "" : `/${encodeURIComponent(chat.turnId)}`}`

/** The chat reference a chat link names, or `value` itself when it is a bare reference. */
export const chatRefOf = (value: string): string => {
  if (!value.startsWith(CHAT_LINK)) return value
  const encoded = value.slice(CHAT_LINK.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

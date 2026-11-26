const CHAT_LINK = "arden:session/"

export const chatHref = (chat: { readonly publicRef: string; readonly turnId?: string }): string =>
  `${CHAT_LINK}${encodeURIComponent(chat.publicRef)}${chat.turnId === undefined ? "" : `/${encodeURIComponent(chat.turnId)}`}`

export const chatRefOf = (value: string): string => {
  if (!value.startsWith(CHAT_LINK)) return value
  const encoded = value.slice(CHAT_LINK.length)
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

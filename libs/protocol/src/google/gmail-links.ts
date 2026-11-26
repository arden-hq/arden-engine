const gmailUrl = (account: string, fragment: string): string =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#${fragment}`

export const gmailThreadUrl = (account: string, threadId: string): string =>
  gmailUrl(account, `all/${encodeURIComponent(threadId)}`)

const GMAIL_VIEW = { all: "all", drafts: "drafts" } as const

type GmailView = (typeof GMAIL_VIEW)[keyof typeof GMAIL_VIEW]

export const gmailViewUrl = (account: string, view: GmailView): string => gmailUrl(account, view)

const GMAIL_HOST = "mail.google.com"

const EMAIL_PATH = /^\/mail\/u\/([^/]*%40[^/]*|[^/]*@[^/]*)\/?$/iu

export const currentGmailUrl = (href: string): string => {
  const url = URL.canParse(href) ? new URL(href) : undefined
  const account =
    url?.hostname === GMAIL_HOST && url.search === ""
      ? EMAIL_PATH.exec(url.pathname)?.[1]
      : undefined
  if (url === undefined || account === undefined) return href
  try {
    return gmailUrl(decodeURIComponent(account), url.hash.slice(1))
  } catch {
    return href
  }
}

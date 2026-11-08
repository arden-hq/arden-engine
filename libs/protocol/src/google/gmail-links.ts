/** Where something opens in Gmail on the web for one signed-in account.
 *  The account goes in the `authuser` query, not the `/mail/u/<email>/`
 *  path: since April 2026 Gmail answers a path email followed by a fragment
 *  (`#all/<id>`, `#sent`) with a 404, while `?authuser=<email>` picks the
 *  account by address and holds when the sign-in order changes. */
const gmailUrl = (account: string, fragment: string): string =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#${fragment}`

/** A Gmail conversation, by its API thread id. */
export const gmailThreadUrl = (account: string, threadId: string): string =>
  gmailUrl(account, `all/${encodeURIComponent(threadId)}`)

/** An account-wide Gmail view: all mail or drafts. */
export const gmailViewUrl = (account: string, view: "all" | "drafts"): string =>
  gmailUrl(account, view)

const EMAIL_PATH = /^\/mail\/u\/([^/]*%40[^/]*|[^/]*@[^/]*)\/?$/iu

/** A link as it opens today. Links Arden stored before the builder above
 *  (`/mail/u/<email>/#…`, in messages, results and change records) move to
 *  the `authuser` shape; every other link, numeric `/u/0/` included, is
 *  returned as given. */
export const currentGmailUrl = (href: string): string => {
  const url = URL.canParse(href) ? new URL(href) : undefined
  const account =
    url?.hostname === "mail.google.com" && url.search === ""
      ? EMAIL_PATH.exec(url.pathname)?.[1]
      : undefined
  if (url === undefined || account === undefined) return href
  try {
    return gmailUrl(decodeURIComponent(account), url.hash.slice(1))
  } catch {
    return href
  }
}

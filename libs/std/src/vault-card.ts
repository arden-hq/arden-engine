/**
 * The rules of payment cards saved in Arden's Vault: what each field may hold, which brand a
 * number is, the card's safe title ("Visa ending 4242"), every spelling of its number a page may
 * show, and how an amount reads. One implementation for the desktop's main process (the store,
 * the fill and its scrub), its Vault page (the dialogs) and the server (what the agent reads and
 * the pay card). The number and the security code never leave the main process; only the safe
 * fields (brand, last 4, expiry, name on card, billing contact) do.
 */

/** The fields the add dialog shows, in its order. Editing changes only the last three. */
export const CARD_FIELDS = [
  "number",
  "expiry",
  "securityCode",
  "nameOnCard",
  "billingContactId"
] as const
export type CardField = (typeof CARD_FIELDS)[number]

export type CardBrand = "Visa" | "Mastercard" | "American Express" | "Card"

/** Why a field was refused, for the dialog's message under it. */
export type CardIssue =
  | "missing"
  | "not_number"
  | "not_valid"
  | "not_expiry"
  | "expired"
  | "not_code"
  | "too_long"
  | "not_one_line"

export interface CardExpiry {
  readonly month: number
  readonly year: number
}

/** A card as the main process stores it. Never sent to the engine or the renderer. */
export interface CardDetails {
  readonly number: string
  readonly expiry: CardExpiry
  readonly securityCode: string
  readonly nameOnCard: string
  readonly billingContactId?: string
}

/** What the agent and the Vault page see of a card. */
export interface CardSafeFields {
  readonly brand: CardBrand
  readonly last4: string
  readonly expiry: string
  readonly nameOnCard: string
  readonly billingContactId?: string
}

const MAX_NAME_LENGTH = 128
const CONTACT_ID = /^[0-9a-f]{24}$/

/** The number's digits, with the spaces and dashes a person types between groups removed. */
export function cardDigits(typed: string): string | undefined {
  const digits = typed.replace(/[ \-]/g, "")
  return /^[0-9]+$/.test(digits) ? digits : undefined
}

/** The brand from the number's first digits: Visa 4, Mastercard 51–55 and 2221–2720, Amex 34 and 37. */
export function cardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return "Visa"
  if (/^3[47]/.test(digits)) return "American Express"
  const two = Number(digits.slice(0, 2))
  const four = Number(digits.slice(0, 4))
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return "Mastercard"
  return "Card"
}

/** The Luhn check every card number passes. */
export function passesLuhn(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

/** The security code's length: 4 digits for American Express, 3 for every other brand. */
export const securityCodeLength = (brand: CardBrand): number =>
  brand === "American Express" ? 4 : 3

function numberIssue(typed: string): CardIssue | undefined {
  if (typed.trim().length === 0) return "missing"
  const digits = cardDigits(typed.trim())
  if (digits === undefined || digits.length < 12 || digits.length > 19) return "not_number"
  if (cardBrand(digits) === "American Express" && digits.length !== 15) return "not_valid"
  return passesLuhn(digits) ? undefined : "not_valid"
}

/** "08/28", "8/28", "08 / 28" or "08/2028", read as month and four-digit year. */
export function readExpiry(typed: string): CardExpiry | undefined {
  const match = /^\s*([0-9]{1,2})\s*\/\s*([0-9]{2}|[0-9]{4})\s*$/.exec(typed)
  if (match === null) return undefined
  const month = Number(match[1])
  const year = match[2]?.length === 2 ? 2000 + Number(match[2]) : Number(match[2])
  return month >= 1 && month <= 12 ? { month, year } : undefined
}

/** Whether a card still works in `now`'s month: it expires at the end of its month. */
export const expiryCurrent = (expiry: CardExpiry, now: Date): boolean =>
  expiry.year > now.getFullYear() ||
  (expiry.year === now.getFullYear() && expiry.month >= now.getMonth() + 1)

function expiryIssue(typed: string, now: Date): CardIssue | undefined {
  if (typed.trim().length === 0) return "missing"
  const expiry = readExpiry(typed)
  if (expiry === undefined || expiry.year > now.getFullYear() + 30) return "not_expiry"
  return expiryCurrent(expiry, now) ? undefined : "expired"
}

function codeIssue(typed: string, brand: CardBrand): CardIssue | undefined {
  const code = typed.trim()
  if (code.length === 0) return "missing"
  return new RegExp(`^[0-9]{${securityCodeLength(brand)}}$`).test(code) ? undefined : "not_code"
}

const oneLine = (typed: string): string => typed.trim().replace(/[ \t]+/g, " ")

function nameIssue(typed: string): CardIssue | undefined {
  const name = oneLine(typed)
  if (name.length === 0) return "missing"
  if (name.length > MAX_NAME_LENGTH) return "too_long"
  return /[\u0000-\u001f\u007f]/.test(name) ? "not_one_line" : undefined
}

const billingIssue = (id: string): CardIssue | undefined =>
  id === "" || CONTACT_ID.test(id) ? undefined : "not_valid"

export type CardRead =
  | { readonly kind: "ok"; readonly card: CardDetails }
  | { readonly kind: "refused"; readonly issues: Readonly<Partial<Record<CardField, CardIssue>>> }

const text = (value: unknown): string => (typeof value === "string" ? value : "")
const notText = (value: unknown): boolean => value !== undefined && typeof value !== "string"

/**
 * Reads a new card as typed in the add dialog: every field but the billing address is required;
 * the number passes Luhn; the expiry is this month or later; the security code has the brand's
 * length. Every refused field is named, so the dialog shows them all at once.
 */
export function readCard(
  input: Readonly<Partial<Record<CardField, unknown>>>,
  now: Date
): CardRead {
  const issues: Partial<Record<CardField, CardIssue>> = {}
  for (const field of CARD_FIELDS) if (notText(input[field])) issues[field] = "not_one_line"
  const number = issues.number ?? numberIssue(text(input.number))
  const digits = cardDigits(text(input.number).trim()) ?? ""
  const checked: Partial<Record<CardField, CardIssue | undefined>> = {
    number,
    expiry: issues.expiry ?? expiryIssue(text(input.expiry), now),
    securityCode: issues.securityCode ?? codeIssue(text(input.securityCode), cardBrand(digits)),
    nameOnCard: issues.nameOnCard ?? nameIssue(text(input.nameOnCard)),
    billingContactId: issues.billingContactId ?? billingIssue(text(input.billingContactId))
  }
  const refused = Object.fromEntries(
    Object.entries(checked).filter(
      (entry): entry is [CardField, CardIssue] => entry[1] !== undefined
    )
  )
  if (Object.keys(refused).length > 0) return { kind: "refused", issues: refused }
  const expiry = readExpiry(text(input.expiry)) ?? { month: 1, year: 1 }
  const billing = text(input.billingContactId)
  return {
    kind: "ok",
    card: {
      number: digits,
      expiry,
      securityCode: text(input.securityCode).trim(),
      nameOnCard: oneLine(text(input.nameOnCard)),
      ...(billing === "" ? {} : { billingContactId: billing })
    }
  }
}

export type CardChangeRead =
  | {
      readonly kind: "ok"
      readonly change: Pick<CardDetails, "expiry" | "nameOnCard" | "billingContactId">
    }
  | { readonly kind: "refused"; readonly issues: Readonly<Partial<Record<CardField, CardIssue>>> }

/** Reads what the edit dialog may change: Expires, Name on card and Billing address. */
export function readCardChange(
  input: Readonly<Partial<Record<"expiry" | "nameOnCard" | "billingContactId", unknown>>>,
  now: Date
): CardChangeRead {
  const checked: Partial<Record<CardField, CardIssue | undefined>> = {
    expiry: notText(input.expiry) ? "not_one_line" : expiryIssue(text(input.expiry), now),
    nameOnCard: notText(input.nameOnCard) ? "not_one_line" : nameIssue(text(input.nameOnCard)),
    billingContactId: notText(input.billingContactId)
      ? "not_one_line"
      : billingIssue(text(input.billingContactId))
  }
  const refused = Object.fromEntries(
    Object.entries(checked).filter(
      (entry): entry is [CardField, CardIssue] => entry[1] !== undefined
    )
  )
  if (Object.keys(refused).length > 0) return { kind: "refused", issues: refused }
  const billing = text(input.billingContactId)
  return {
    kind: "ok",
    change: {
      expiry: readExpiry(text(input.expiry)) ?? { month: 1, year: 1 },
      nameOnCard: oneLine(text(input.nameOnCard)),
      ...(billing === "" ? {} : { billingContactId: billing })
    }
  }
}

/** Why one typed field is refused, or undefined: the same check `readCard` makes. */
export function cardFieldIssue(
  field: CardField,
  typed: string,
  context: { readonly number: string; readonly now: Date }
): CardIssue | undefined {
  switch (field) {
    case "number":
      return numberIssue(typed)
    case "expiry":
      return expiryIssue(typed, context.now)
    case "securityCode":
      return codeIssue(typed, cardBrand(cardDigits(context.number.trim()) ?? ""))
    case "nameOnCard":
      return nameIssue(typed)
    case "billingContactId":
      return billingIssue(typed)
  }
}

/** "08/28". */
export const expiryText = (expiry: CardExpiry): string =>
  `${String(expiry.month).padStart(2, "0")}/${String(expiry.year % 100).padStart(2, "0")}`

/** What may be shown of a stored card: never the number or the security code. */
export function cardSafeFields(card: CardDetails): CardSafeFields {
  return {
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expiry: expiryText(card.expiry),
    nameOnCard: card.nameOnCard,
    ...(card.billingContactId === undefined ? {} : { billingContactId: card.billingContactId })
  }
}

/** "Visa ending 4242"; a number of no known brand is a "Card ending 4242". */
export const cardTitle = (card: Pick<CardSafeFields, "brand" | "last4">): string =>
  `${card.brand} ending ${card.last4}`

export type AmountRead =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "refused" }

/**
 * An amount to pay as the card says it: "84.20" in "USD" reads "$84.20". The amount is a plain
 * decimal above zero with no more decimals than the currency has; the currency is a three-letter
 * code the system knows.
 */
export function readAmount(amount: string, currency: string): AmountRead {
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code) || !knownCurrency(code)) return { kind: "refused" }
  const match = /^([0-9]{1,9})(?:\.([0-9]+))?$/.exec(amount.trim())
  if (match === null) return { kind: "refused" }
  // oxlint-disable-next-line arden/restricted-owner -- a money amount in its currency, which count does not format
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency: code })
  const decimals = match[2]?.length ?? 0
  const value = Number(amount.trim())
  // oxlint-disable-next-line arden/restricted-owner -- the currency's decimals, not a time zone
  if (decimals > (format.resolvedOptions().maximumFractionDigits ?? 2) || !(value > 0))
    return { kind: "refused" }
  return { kind: "ok", text: format.format(value) }
}

const knownCurrency = (code: string): boolean => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  return supported === undefined ? true : supported("currency").includes(code)
}

export const CARD_FIELD = {
  number: "number",
  expiry: "expiry",
  securityCode: "securityCode",
  nameOnCard: "nameOnCard",
  billingContactId: "billingContactId"
} as const
export type CardField = (typeof CARD_FIELD)[keyof typeof CARD_FIELD]
export const CARD_FIELDS: ReadonlyArray<CardField> = Object.values(CARD_FIELD)

export const CARD_BRAND = {
  visa: "Visa",
  mastercard: "Mastercard",
  americanExpress: "American Express",
  card: "Card"
} as const
export type CardBrand = (typeof CARD_BRAND)[keyof typeof CARD_BRAND]

export const CARD_ISSUE = {
  missing: "missing",
  notNumber: "not_number",
  notValid: "not_valid",
  notExpiry: "not_expiry",
  expired: "expired",
  notCode: "not_code",
  tooLong: "too_long",
  notOneLine: "not_one_line"
} as const
export type CardIssue = (typeof CARD_ISSUE)[keyof typeof CARD_ISSUE]

export interface CardExpiry {
  readonly month: number
  readonly year: number
}

export interface CardDetails {
  readonly number: string
  readonly expiry: CardExpiry
  readonly securityCode: string
  readonly nameOnCard: string
  readonly billingContactId?: string
}

export interface CardSafeFields {
  readonly brand: CardBrand
  readonly last4: string
  readonly expiry: string
  readonly nameOnCard: string
  readonly billingContactId?: string
}

const MAX_NAME_LENGTH = 128
const CONTACT_ID = /^[0-9a-f]{24}$/

export function cardDigits(typed: string): string | undefined {
  const digits = typed.replace(/[ \-]/g, "")
  return /^[0-9]+$/.test(digits) ? digits : undefined
}

export function cardBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return CARD_BRAND.visa
  if (/^3[47]/.test(digits)) return CARD_BRAND.americanExpress
  const two = Number(digits.slice(0, 2))
  const four = Number(digits.slice(0, 4))
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return CARD_BRAND.mastercard
  return CARD_BRAND.card
}

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

export const securityCodeLength = (brand: CardBrand): number =>
  brand === CARD_BRAND.americanExpress ? 4 : 3

function numberIssue(typed: string): CardIssue | undefined {
  if (typed.trim().length === 0) return "missing"
  const digits = cardDigits(typed.trim())
  if (digits === undefined || digits.length < 12 || digits.length > 19) return "not_number"
  if (cardBrand(digits) === CARD_BRAND.americanExpress && digits.length !== 15)
    return CARD_ISSUE.notValid
  return passesLuhn(digits) ? undefined : "not_valid"
}

export function readExpiry(typed: string): CardExpiry | undefined {
  const match = /^\s*([0-9]{1,2})\s*\/\s*([0-9]{2}|[0-9]{4})\s*$/.exec(typed)
  if (match === null) return undefined
  const month = Number(match[1])
  const year = match[2]?.length === 2 ? 2000 + Number(match[2]) : Number(match[2])
  return month >= 1 && month <= 12 ? { month, year } : undefined
}

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

export function cardFieldIssue(
  field: CardField,
  typed: string,
  context: { readonly number: string; readonly now: Date }
): CardIssue | undefined {
  switch (field) {
    case CARD_FIELD.number:
      return numberIssue(typed)
    case CARD_FIELD.expiry:
      return expiryIssue(typed, context.now)
    case CARD_FIELD.securityCode:
      return codeIssue(typed, cardBrand(cardDigits(context.number.trim()) ?? ""))
    case CARD_FIELD.nameOnCard:
      return nameIssue(typed)
    case CARD_FIELD.billingContactId:
      return billingIssue(typed)
  }
}

export const expiryText = (expiry: CardExpiry): string =>
  `${String(expiry.month).padStart(2, "0")}/${String(expiry.year % 100).padStart(2, "0")}`

export function cardSafeFields(card: CardDetails): CardSafeFields {
  return {
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expiry: expiryText(card.expiry),
    nameOnCard: card.nameOnCard,
    ...(card.billingContactId === undefined ? {} : { billingContactId: card.billingContactId })
  }
}

export const cardTitle = (card: Pick<CardSafeFields, "brand" | "last4">): string =>
  `${card.brand} ending ${card.last4}`

export const AMOUNT_READ = { ok: "ok", refused: "refused" } as const

export type AmountRead =
  | { readonly kind: typeof AMOUNT_READ.ok; readonly text: string }
  | { readonly kind: typeof AMOUNT_READ.refused }

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

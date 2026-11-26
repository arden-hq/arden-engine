export const CONTACT_FIELD = {
  name: "name",
  email: "email",
  phone: "phone",
  addressLine1: "addressLine1",
  addressLine2: "addressLine2",
  city: "city",
  postalCode: "postalCode",
  region: "region",
  country: "country"
} as const
export type ContactField = (typeof CONTACT_FIELD)[keyof typeof CONTACT_FIELD]
export const CONTACT_FIELDS: ReadonlyArray<ContactField> = Object.values(CONTACT_FIELD)

export const CONTACT_FIELD_LABEL: Readonly<Record<ContactField, string>> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  addressLine1: "Address line 1",
  addressLine2: "Address line 2",
  city: "City",
  postalCode: "Postal code",
  region: "State or region",
  country: "Country"
}

const MAX_LENGTH: Readonly<Record<ContactField, number>> = {
  name: 128,
  email: 254,
  phone: 32,
  addressLine1: 128,
  addressLine2: 128,
  city: 128,
  postalCode: 32,
  region: 128,
  country: 64
}

export type ContactDetails = { readonly name: string } & {
  readonly [Field in Exclude<ContactField, typeof CONTACT_FIELD.name>]?: string
}

export const CONTACT_ISSUE = {
  missing: "missing",
  tooLong: "too_long",
  notOneLine: "not_one_line",
  notEmail: "not_email",
  notPhone: "not_phone"
} as const
export type ContactIssue = (typeof CONTACT_ISSUE)[keyof typeof CONTACT_ISSUE]

export const CONTACT_READ = { ok: "ok", refused: "refused" } as const

export type ContactRead =
  | { readonly kind: typeof CONTACT_READ.ok; readonly contact: ContactDetails }
  | {
      readonly kind: typeof CONTACT_READ.refused
      readonly field: ContactField
      readonly issue: ContactIssue
    }

export function readContact(input: Readonly<Partial<Record<ContactField, unknown>>>): ContactRead {
  const fields: Partial<Record<ContactField, string>> = {}
  for (const field of CONTACT_FIELDS) {
    const raw = input[field]
    if (raw !== undefined && typeof raw !== "string")
      return { kind: "refused", field, issue: "not_one_line" }
    const value = oneLine(raw ?? "")
    const issue = fieldIssue(field, value)
    if (issue !== undefined) return { kind: "refused", field, issue }
    if (value.length > 0) fields[field] = value
  }
  const { name, ...rest } = fields
  return name === undefined
    ? { kind: "refused", field: "name", issue: "missing" }
    : { kind: "ok", contact: { name, ...rest } }
}

export function contactFieldIssue(field: ContactField, typed: string): ContactIssue | undefined {
  return fieldIssue(field, oneLine(typed))
}

const oneLine = (typed: string): string => typed.trim().replace(/[ \t]+/g, " ")

function fieldIssue(field: ContactField, value: string): ContactIssue | undefined {
  if (value.length === 0) return field === CONTACT_FIELD.name ? CONTACT_ISSUE.missing : undefined
  if (value.length > MAX_LENGTH[field]) return "too_long"
  if (/[\u0000-\u001f\u007f]/.test(value)) return "not_one_line"
  if (field === CONTACT_FIELD.email && !/^[^\s@]+@[^\s@]+$/.test(value))
    return CONTACT_ISSUE.notEmail
  if (field === CONTACT_FIELD.phone && !/^[0-9 +\-()]*[0-9][0-9 +\-()]*$/.test(value))
    return CONTACT_ISSUE.notPhone
  return undefined
}

export const contactFieldLimit = (field: ContactField): number => MAX_LENGTH[field]

export function addressLine(contact: ContactDetails): string {
  const town = [contact.city, contact.postalCode].filter(isFilled).join(" ")
  return [contact.addressLine1, contact.addressLine2, town, contact.region, contact.country]
    .filter(isFilled)
    .join(", ")
}

const isFilled = (part: string | undefined): part is string => part !== undefined && part.length > 0

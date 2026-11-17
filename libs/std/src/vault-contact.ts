/**
 * The rules of contact details saved in Arden's Vault: which fields one item has, what each may
 * hold, and how its address reads on one line. One implementation for the desktop's main process
 * (the store), its Vault page (the dialogs) and the server (what the agent reads). Contact details
 * are not secret: the agent reads them to fill in forms.
 */

/** The fields of one item, in the order the dialog shows them. Only `name` is required. */
export const CONTACT_FIELDS = [
  "name",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "postalCode",
  "region",
  "country"
] as const
export type ContactField = (typeof CONTACT_FIELDS)[number]

/** Each field's label, as the dialog and the agent's list name it. */
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

/** One item's fields, trimmed; a blank optional field is left out. */
export type ContactDetails = { readonly name: string } & {
  readonly [Field in Exclude<ContactField, "name">]?: string
}

/** Why a field was refused, for the dialog's message under it. */
export type ContactIssue = "missing" | "too_long" | "not_one_line" | "not_email" | "not_phone"

export type ContactRead =
  | { readonly kind: "ok"; readonly contact: ContactDetails }
  | { readonly kind: "refused"; readonly field: ContactField; readonly issue: ContactIssue }

/**
 * Reads typed or stored fields into one item. Each field is one line, trimmed, with runs of
 * spaces made one; only Name is required. Email and phone are checked lightly: an email has
 * an "@" with text on both sides and no spaces, a phone holds digits, spaces, "+", "-", "(" and ")".
 */
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

/**
 * Why one typed field is refused, or undefined when it reads: the same check `readContact`
 * makes, for a form that shows every refused field at once.
 */
export function contactFieldIssue(field: ContactField, typed: string): ContactIssue | undefined {
  return fieldIssue(field, oneLine(typed))
}

const oneLine = (typed: string): string => typed.trim().replace(/[ \t]+/g, " ")

function fieldIssue(field: ContactField, value: string): ContactIssue | undefined {
  if (value.length === 0) return field === "name" ? "missing" : undefined
  if (value.length > MAX_LENGTH[field]) return "too_long"
  if (/[\u0000-\u001f\u007f]/.test(value)) return "not_one_line"
  if (field === "email" && !/^[^\s@]+@[^\s@]+$/.test(value)) return "not_email"
  if (field === "phone" && !/^[0-9 +\-()]*[0-9][0-9 +\-()]*$/.test(value)) return "not_phone"
  return undefined
}

/** The longest a field may be, for the message that says so. */
export const contactFieldLimit = (field: ContactField): number => MAX_LENGTH[field]

/**
 * The address on one line, ending with the country: "12 Marsh Lane, Flat 2, Bristol BS1 4DJ,
 * England, United Kingdom". City and postal code share a part, as on an envelope.
 */
export function addressLine(contact: ContactDetails): string {
  const town = [contact.city, contact.postalCode].filter(isFilled).join(" ")
  return [contact.addressLine1, contact.addressLine2, town, contact.region, contact.country]
    .filter(isFilled)
    .join(", ")
}

const isFilled = (part: string | undefined): part is string => part !== undefined && part.length > 0

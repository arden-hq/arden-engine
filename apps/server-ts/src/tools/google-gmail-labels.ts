import { toolRefusal } from "./tool-failure.js"

export interface GmailLabel {
  readonly id: string
  readonly name: string
  readonly type: "system" | "user"
}

export interface MailboxFlags {
  readonly archive?: boolean
  readonly read?: boolean
  readonly starred?: boolean
  readonly important?: boolean
}

export interface LabelChange {
  readonly add: ReadonlyArray<string>
  readonly remove: ReadonlyArray<string>
}

export const flagLabelChanges = (flags: MailboxFlags): LabelChange => {
  const add: Array<string> = []
  const remove: Array<string> = []
  const toggle = (on: boolean | undefined, label: string, whenOn: "add" | "remove"): void => {
    if (on === undefined) return
    const addsIt = whenOn === "add" ? on : !on
    ;(addsIt ? add : remove).push(label)
  }
  toggle(flags.archive, "INBOX", "remove")
  toggle(flags.read, "UNREAD", "remove")
  toggle(flags.starred, "STARRED", "add")
  toggle(flags.important, "IMPORTANT", "add")
  return { add, remove }
}

export const resolveLabelIds = (
  requested: ReadonlyArray<string>,
  labels: ReadonlyArray<Pick<GmailLabel, "id" | "name">>
): ReadonlyArray<string> => {
  const unknown: Array<string> = []
  const ids = requested.flatMap((value) => {
    const wanted = value.trim().toLowerCase()
    const found =
      labels.find((label) => label.id === value.trim()) ??
      labels.find((label) => label.name.toLowerCase() === wanted)
    if (found === undefined) unknown.push(value)
    return found === undefined ? [] : [found.id]
  })
  if (unknown.length > 0) {
    throw toolRefusal(
      `No Gmail label matches ${unknown.map((value) => `"${value}"`).join(", ")}. Call email_label_list for the exact names; Arden does not create labels.`,
      "Unknown Gmail label"
    )
  }
  return ids
}

export const mergeLabelChanges = (
  flags: LabelChange,
  labels: LabelChange
): { readonly add: ReadonlyArray<string>; readonly remove: ReadonlyArray<string> } => {
  const add = [...new Set([...flags.add, ...labels.add])]
  const remove = [...new Set([...flags.remove, ...labels.remove])]
  const both = add.filter((id) => remove.includes(id))
  if (both.length > 0) {
    throw toolRefusal(
      `The same label is both added and removed: ${both.join(", ")}.`,
      "Conflicting label changes"
    )
  }
  if (add.length === 0 && remove.length === 0) {
    throw toolRefusal(
      "email_update needs at least one change: archive, read, starred, important, add_labels or remove_labels.",
      "Nothing to change"
    )
  }
  return { add, remove }
}

export interface RestoreGroup {
  readonly message_ids: ReadonlyArray<string>
  readonly add_labels: ReadonlyArray<string>
  readonly remove_labels: ReadonlyArray<string>
}

export interface MessageLabels {
  readonly id: string
  readonly labels: ReadonlyArray<string>
}

export const restoreGroups = (
  before: ReadonlyArray<MessageLabels>,
  change: LabelChange
): ReadonlyArray<RestoreGroup> => {
  const groups = new Map<
    string,
    { add: Array<string>; remove: Array<string>; ids: Array<string> }
  >()
  for (const message of before) {
    const add = change.remove.filter((id) => message.labels.includes(id))
    const remove = change.add.filter((id) => !message.labels.includes(id))
    if (add.length === 0 && remove.length === 0) continue
    const key = JSON.stringify([add, remove])
    const group = groups.get(key) ?? { add, remove, ids: [] }
    group.ids.push(message.id)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    message_ids: group.ids,
    add_labels: group.add,
    remove_labels: group.remove
  }))
}

export const mergeRestoreGroups = (
  all: ReadonlyArray<RestoreGroup>
): ReadonlyArray<RestoreGroup> => {
  const merged = new Map<string, { group: RestoreGroup; ids: Array<string> }>()
  for (const group of all) {
    const key = JSON.stringify([group.add_labels, group.remove_labels])
    const held = merged.get(key) ?? { group, ids: [] }
    held.ids.push(...group.message_ids)
    merged.set(key, held)
  }
  return [...merged.values()].map(({ group, ids }) => ({ ...group, message_ids: ids }))
}

export const changeVerbs = (
  request: MailboxFlags & {
    readonly add_labels?: ReadonlyArray<string>
    readonly remove_labels?: ReadonlyArray<string>
  }
): ReadonlyArray<string> => {
  const verbs: Array<string> = []
  if (request.archive !== undefined) verbs.push(request.archive ? "archive" : "move to Inbox")
  if (request.read !== undefined) verbs.push(request.read ? "mark read" : "mark unread")
  if (request.starred !== undefined) verbs.push(request.starred ? "star" : "unstar")
  if (request.important !== undefined) {
    verbs.push(request.important ? "mark important" : "mark not important")
  }
  if (request.add_labels !== undefined && request.add_labels.length > 0) {
    verbs.push(`add ${request.add_labels.join(", ")}`)
  }
  if (request.remove_labels !== undefined && request.remove_labels.length > 0) {
    verbs.push(`remove ${request.remove_labels.join(", ")}`)
  }
  return verbs
}

import { countOf, listWords } from "@arden-hq/std/count"
import { fitsCard, keyName, readAddresses } from "@arden-hq/std/vault-key"
import { CONTACT_FIELD_LABEL, CONTACT_FIELDS } from "@arden-hq/std/vault-contact"
import { APPROVAL_FIELD_LABEL, type ChatApprovalMode } from "@arden-hq/protocol/chat"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { Effect, Schema } from "effect"

import {
  looksLikeSecret,
  VAULT_USE_KEY_TOOL,
  VaultKeys,
  type VaultKeysService,
  type VaultList
} from "../credentials/vault-keys.js"
import { matchesVaultKey, readRunRules, ruleDecision } from "../execution/rules.js"
import { personCard } from "../execution/decide.js"
import type { RunAuthority } from "../execution/authority.js"
import { PermissionRules, type RuleDecision } from "../persistence/permissions/rules.js"
import { EmptyParametersSchema } from "./automation-tool-schema.js"
import { browserAskSecretTools } from "./browser-ask-secret.js"
import { cardLines, vaultCardTools } from "./vault-cards.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import { toolRefusal } from "./tool-failure.js"

const KeyNameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

const UseKeyParametersSchema = Schema.Struct({
  name: KeyNameSchema.pipe(
    Schema.annotateEncoded({
      description: "The key's name exactly as vault_list shows it, such as Todoist."
    })
  ),
  reason: ReasonSchema.pipe(
    Schema.annotateEncoded({
      description:
        "One short sentence for the user: what you will do with it, such as: You asked me to add “Renew passport” to your tasks. Never a key or any other secret."
    })
  )
})

const AskKeyParametersSchema = Schema.Struct({
  name: KeyNameSchema.pipe(
    Schema.annotateEncoded({
      description:
        "A plain name for the service the key is for, as a person would say it: Todoist, OpenAI. Not a variable name."
    })
  ),
  addresses: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(260)))
    .check(Schema.isMinLength(1), Schema.isMaxLength(16))
    .annotate({
      description:
        "The service's API addresses the key may be sent to, from its documentation: hosts such as api.todoist.com, or a local address with its port such as localhost:11434. Arden sends the key nowhere else."
    }),
  reason: ReasonSchema.pipe(
    Schema.annotateEncoded({
      description: "One short sentence for the user: what you need the key for. Never a secret."
    })
  )
})

type KeyUse =
  | { readonly kind: "allowed" }
  | { readonly kind: "ask" }
  | { readonly kind: "refuse"; readonly reason: "never" | "read_only" }

export const keyUseDecision = (input: {
  readonly answered: boolean
  readonly rule: RuleDecision | undefined
  readonly mode: ChatApprovalMode
}): KeyUse => {
  if (input.rule === "never") return { kind: "refuse", reason: "never" }
  if (input.answered || input.rule === "allow") return { kind: "allowed" }
  return personCard(input.mode) === "read_only"
    ? { kind: "refuse", reason: "read_only" }
    : { kind: "ask" }
}

const USE_REFUSAL: Record<Extract<KeyUse, { kind: "refuse" }>["reason"], string> = {
  never:
    "The user's rule says Arden never uses this key. Do not try another way; say what you needed it for.",
  read_only: "This run is read-only, so it may not use a saved key."
}

const findKey = (list: VaultList, name: string) =>
  list.keys.find((key) => key.name.toLowerCase() === name.toLowerCase())

const vaultRefusal = (cause: unknown): never => {
  throw toolRefusal(
    cause instanceof Error && cause.name === "VaultUnavailableError"
      ? cause.message
      : "Arden could not read its Vault just now. Try again in a moment.",
    "Vault unavailable"
  )
}

const listOrRefuse = (vault: VaultKeysService): Promise<VaultList> =>
  vault.list().catch(vaultRefusal)

const refuseSecretShaped = (reason: string): void => {
  if (looksLikeSecret(reason))
    throw toolRefusal(
      "The reason looks like it holds a secret. Write it again in plain words, with no key, password or token in it.",
      "Reason refused"
    )
}

const useCard = (
  key: { readonly id: string; readonly name: string; readonly addresses: ReadonlyArray<string> },
  reason: string
): ServerApprovalPrompt => ({
  preview: `Use your ${key.name} key`,
  presentation: {
    title: `Use your ${key.name} key?`,
    fields: [
      { label: APPROVAL_FIELD_LABEL.key, value: key.name },
      { label: APPROVAL_FIELD_LABEL.sendTo, value: key.addresses.join(", ") },
      { label: APPROVAL_FIELD_LABEL.reason, value: reason }
    ],
    approve_label: DECISION_WORD.allowOnce,
    reject_label: DECISION_WORD.deny
  },
  data: { reviewer: "user", vault_key: key.name, vault_key_id: key.id }
})

const askCard = (input: {
  readonly name: string
  readonly addresses: ReadonlyArray<string>
  readonly reason: string
}): ServerApprovalPrompt => ({
  preview: `Add a ${input.name} key`,
  presentation: {
    title: `Add a ${input.name} key`,
    fields: [
      { label: APPROVAL_FIELD_LABEL.key, value: input.name },
      { label: APPROVAL_FIELD_LABEL.sendTo, value: input.addresses.join(", ") },
      { label: APPROVAL_FIELD_LABEL.reason, value: input.reason }
    ],
    approve_label: "Save key",
    reject_label: "Not now"
  },
  data: { reviewer: "user", vault_key: input.name }
})

const exampleUrl = (address: string): string =>
  /^(?:localhost|127\.|\[::1\])/.test(address) ? `http://${address}/...` : `https://${address}/...`

const usable = (key: {
  readonly name: string
  readonly variable: string
  readonly addresses: ReadonlyArray<string>
}) =>
  [
    `You may use the ${key.name} key in this run's commands as $${key.variable}.`,
    `The variable holds a stand-in, not the key: Arden swaps in the real key as the request leaves, only for ${listWords([...key.addresses])}, and only in a request header (for example curl -H "Authorization: Bearer $${key.variable}" ${exampleUrl(key.addresses[0] ?? "")}).`,
    "Run the command with access network or host; a sandboxed command has no network. Never print the variable or write it to a file: it is useless anywhere else, and the real key never reaches you."
  ].join(" ")

const vaultListText = (list: VaultList): { result: string; preview: string } => {
  const keys = list.keys.map(
    (key) => `- ${key.name}: $${key.variable}, sent only to ${key.addresses.join(", ")}`
  )
  const passwords = list.passwords.map(
    (saved) =>
      `- ${new URL(saved.site).host}: ${saved.name}${saved.userName === undefined ? "" : `, user name ${saved.userName}`}`
  )
  const cards = cardLines(list)
  const contacts = (list.contacts ?? []).map((contact) =>
    [
      `- ${contact.name}`,
      ...CONTACT_FIELDS.flatMap((field) => {
        const value = contact[field]
        return field === "name" || value === undefined
          ? []
          : [`  ${CONTACT_FIELD_LABEL[field]}: ${value}`]
      })
    ].join("\n")
  )
  return {
    result: [
      keys.length === 0 ? "Keys: none saved." : ["Keys:", ...keys].join("\n"),
      passwords.length === 0
        ? "Site passwords: none saved."
        : ["Site passwords (browser_act fills them):", ...passwords].join("\n"),
      contacts.length === 0
        ? "Contact details: none saved."
        : [
            "Contact details (type them into forms the user asked you to fill; never send them anywhere the user did not ask):",
            ...contacts
          ].join("\n"),
      cards.length === 0
        ? "Cards: none saved."
        : [
            "Cards (pay with vault_pay, then fill with browser_act card; you never see the number or the security code):",
            ...cards
          ].join("\n")
    ].join("\n\n"),
    preview: [
      countOf(list.keys.length, "key"),
      countOf(list.passwords.length, "password"),
      countOf(contacts.length, "contact"),
      countOf(cards.length, "card")
    ].join(", ")
  }
}

const makeVaultListTool = (vault: VaultKeysService): ServerTool =>
  defineServerTool({
    name: "vault_list",
    summary:
      "Lists your saved keys, site passwords and cards by name, never their values, and your contact details.",
    discovery: { group: "vault" },
    description: [
      "List what the user keeps in Arden's Vault: API keys (name, the environment variable a command reads it from, and the addresses it may go to), saved site passwords (site, name and user name), contact details (name, email, phone and address, in full), and payment cards (id, brand, last 4 digits, expiry, name on card and billing address).",
      "Keys and passwords come without values: you cannot read them, and you never need to. Call it before a command that needs a key, then vault_use_key; ask for a missing key with vault_ask_key.",
      "Contact details are not secret: use them to fill in forms the user asked you to fill, typing them with the browser tools. Do not send them anywhere the user did not ask.",
      "Cards come without their number or security code: pay with vault_pay."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(EmptyParametersSchema),
    metadata: {
      effect: "none",
      display_name: "Vault",
      kind: "tool",
      action: "read",
      approval_preview:
        "List what the Vault holds: names, contact details in full, cards without their numbers.",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: null
    },
    execute: async () => vaultListText(await listOrRefuse(vault))
  })

const makeVaultUseKeyTool = (
  vault: VaultKeysService,
  rules: PermissionRules["Service"]
): ServerTool => {
  const ruleFor = async (authority: RunAuthority, keyId: string) => {
    const read = await Effect.runPromise(readRunRules(rules, authority)).catch(() => undefined)
    return read === undefined ? undefined : ruleDecision(read, matchesVaultKey(keyId))
  }
  return defineServerTool({
    name: VAULT_USE_KEY_TOOL,
    summary: "Asks to use a saved key in commands; only its own addresses get it.",
    discovery: { group: "vault" },
    description: [
      "Ask to use one of the user's saved API keys in this run's commands. The user allows it once, always in this Space, or denies; a rule may answer without asking.",
      "Once allowed, every later exec_command in this run gets the key's environment variable (vault_list names it) holding a stand-in value, and Arden puts the real key in as the request leaves for the key's own addresses. You never see the key.",
      "Give a reason in plain words; never put a key, password or token in it."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(UseKeyParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "vault_key_use" }],
      effect: "none",
      display_name: "Use a key",
      kind: "tool",
      action: "read",
      approval_preview: "Use a saved key in this run's commands.",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      policy_scope: "external",
      code_mode: false
    },
    approvalRequirement: async (input, ctx) => {
      refuseSecretShaped(input.reason)
      const key = findKey(await listOrRefuse(vault), input.name)
      if (key === undefined) return undefined
      const decision = keyUseDecision({
        answered: false,
        rule: await ruleFor(ctx.run.authority, key.id),
        mode: ctx.run.approvalMode
      })
      return decision.kind === "ask" ? useCard(key, input.reason) : undefined
    },
    execute: async (input, ctx) => {
      refuseSecretShaped(input.reason)
      const key = findKey(await listOrRefuse(vault), input.name)
      if (key === undefined)
        throw toolRefusal(
          `No key named ${input.name} is saved. Check vault_list, or ask the user for it with vault_ask_key.`,
          "No such key"
        )
      const decision = keyUseDecision({
        answered: ctx.approval?.data?.["vault_key_id"] === key.id,
        rule: await ruleFor(ctx.run.authority, key.id),
        mode: ctx.run.approvalMode
      })
      switch (decision.kind) {
        case "refuse":
          throw toolRefusal(USE_REFUSAL[decision.reason], DECISION_WORD.denied)
        case "ask":
          throw toolRefusal("A key is allowed only on the user's card.", "Needs approval")
        case "allowed":
          vault.grant(ctx.run.runId, key.id)
          return { result: usable(key), preview: `${key.name} key allowed` }
      }
    }
  })
}

const makeVaultAskKeyTool = (vault: VaultKeysService): ServerTool => {
  const readAsk = (input: typeof AskKeyParametersSchema.Type) => {
    const name = keyName(input.name)
    const addresses = readAddresses(input.addresses.join(" "))
    if (name === undefined)
      throw toolRefusal("Give the key a plain name of up to 64 characters.", "Name refused")
    if (addresses.kind !== "ok")
      throw toolRefusal(
        "Each address must be a host such as api.todoist.com, or a local address with its port such as localhost:11434.",
        "Address refused"
      )
    if (!fitsCard(addresses.addresses))
      throw toolRefusal(
        "Suggest at most 3 addresses, each at most 80 characters: the service's main API hosts. The user can add more in Settings → Vault.",
        "Too many addresses"
      )
    refuseSecretShaped(input.reason)
    return { name, addresses: addresses.addresses, reason: input.reason }
  }
  return defineServerTool({
    name: "vault_ask_key",
    summary: "Asks you to add a missing key on a card; the agent never sees it.",
    discovery: { group: "vault" },
    description: [
      "Ask the user to add an API key that is not in the Vault yet, on a secure card in the chat where they paste it.",
      "Never ask for a key, password or token in the chat, and never ask the user to paste one into a message or a file.",
      "Check vault_list first; ask only for a key that is missing, with the service's API addresses and a reason in plain words. The addresses are a suggestion: the user sees them on the card and keeps, changes or removes them, and only what they keep is saved.",
      "Once the user saves it, this run may use it at once, as vault_use_key describes. In a run no one is watching it does not ask."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(AskKeyParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "vault_key_ask" }],
      effect: "none",
      display_name: "Ask for a key",
      kind: "tool",
      action: "read",
      approval_preview: "Ask the user to add a key.",
      source: "_system",
      changes_state: false,
      concurrency_group: null,
      destructive: null,
      approval_bypass: true,
      refuse_unattended: true,
      policy_scope: "external",
      code_mode: false
    },
    approvalRequirement: async (input, ctx) => {
      const ask = readAsk(input)
      if (findKey(await listOrRefuse(vault), ask.name) !== undefined) return undefined
      if (personCard(ctx.run.approvalMode) !== "ask") return undefined
      if (!vault.takeAsk(ctx.run.sessionId, ctx.toolCallId))
        throw toolRefusal(
          "You asked the user for keys or passwords 5 times in 5 minutes. Stop asking; say what you need and let the user add it in Settings → Vault.",
          "Too many asks"
        )
      return askCard(ask)
    },
    execute: async (input, ctx) => {
      const ask = readAsk(input)
      const key = findKey(await listOrRefuse(vault), ask.name)
      if (key !== undefined) {
        if (ctx.approval !== undefined) vault.grant(ctx.run.runId, key.id)
        return {
          result:
            ctx.approval === undefined
              ? `A key named ${key.name} is already saved. Use it with vault_use_key.`
              : `The user saved the ${key.name} key. ${usable(key)}`,
          preview: `${key.name} key saved`
        }
      }
      if (personCard(ctx.run.approvalMode) !== "ask")
        return {
          result:
            "Not asked: in this mode Arden does not ask the user for a key. Tell the user they can add it in Settings → Vault.",
          preview: "Not asked"
        }
      throw toolRefusal(
        `Nothing was saved for ${ask.name}. Ask again only if the user wants to add it.`,
        "Nothing saved"
      )
    }
  })
}

const UNCHECKED_OUTPUT =
  "[Arden could not check this output for saved keys and passwords, so it is not shown.]"

export const vaultResultScrub = Effect.gen(function* () {
  const vault = yield* VaultKeys
  return (text: string): Promise<string> => vault.redact(text).catch(() => UNCHECKED_OUTPUT)
})

export const vaultTools = Effect.gen(function* () {
  const vault = yield* VaultKeys
  const rules = yield* PermissionRules
  return [
    makeVaultListTool(vault),
    makeVaultUseKeyTool(vault, rules),
    makeVaultAskKeyTool(vault),
    ...(yield* browserAskSecretTools),
    ...(yield* vaultCardTools)
  ]
})

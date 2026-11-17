import { cardTitle, readAmount } from "@arden-hq/std/vault-card"
import { APPROVAL_FIELD_LABEL } from "@arden-hq/protocol/chat"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { Effect, Schema } from "effect"

import { BrowserClient, CardIdSchema } from "../browser/service.js"
import {
  looksLikeSecret,
  VaultKeys,
  type VaultKeysService,
  type VaultList
} from "../credentials/vault-keys.js"
import { personCard } from "../execution/decide.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { tabOriginOf } from "./browser-ask-secret.js"
import { runBrowserForRun, TabRefSchema } from "./browser-support.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { toolRefusal } from "./tool-failure.js"

/**
 * Paying with a saved card. The agent asks with `vault_pay`; the owner answers on the card with
 * Touch ID, which the desktop's main process prompts and checks itself. Only then does the desktop
 * type that card's fields (browser_act with `card`) on that shop's tab, for 10 minutes or until
 * the tab leaves the shop. This server never sees the number or the security code, and has no way
 * to open a payment on its own: an approval here only says the owner answered the card.
 */

/** How long a payment the owner approved lets Arden type the card, as the desktop holds it. */
const APPROVAL_MINUTES = 10

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

/** https, or plain http on this Mac, as the desktop allows: an exact origin with no path. */
const shopIssues = (value: string, path: string): Array<Schema.FilterIssue> => {
  if (!URL.canParse(value)) return [{ path: [path], issue: "must be an exact https origin" }]
  const url = new URL(value)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  const secure = url.protocol === "https:" || (url.protocol === "http:" && local)
  return url.origin === value && secure
    ? []
    : [{ path: [path], issue: "must be an exact https origin without a path" }]
}

const PayParametersSchema = Schema.Struct({
  card_id: CardIdSchema.annotate({ description: "The card's id from vault_list." }),
  amount: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16)).annotate({
    description:
      "The total the shop's page shows for this order, as a plain number such as 84.20. Arden cannot check it against the page; give exactly what the page says."
  }),
  currency: Schema.String.check(Schema.isPattern(/^[A-Za-z]{3}$/u)).annotate({
    description: "The three-letter currency code the page charges in, such as USD or EUR."
  }),
  shop: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
    description:
      "The tab's exact current origin, such as https://www.booking.com, without a path. It must match the tab."
  }),
  tab_ref: TabRefSchema.annotate({ description: "The tab showing the checkout." }),
  reason: ReasonSchema.pipe(
    Schema.annotateEncoded({
      description:
        "One short sentence for the user: what the payment is for, such as: You asked me to book the Lisbon hotel for 12 December. Never a card number or any other secret."
    })
  )
}).check(Schema.makeFilter((input) => shopIssues(input.shop, "shop")))

const FrameParametersSchema = Schema.Struct({
  card_id: CardIdSchema.annotate({ description: "The card's id, as on vault_pay." }),
  frame: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
    description: "The payment frame's origin exactly as browser_act's refusal named it."
  }),
  shop: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048)).annotate({
    description: "The shop's origin, as on vault_pay."
  }),
  tab_ref: TabRefSchema.annotate({ description: "The checkout's tab, as on vault_pay." })
}).check(
  Schema.makeFilter((input) => [
    ...shopIssues(input.shop, "shop"),
    ...shopIssues(input.frame, "frame")
  ])
)

type PayInput = typeof PayParametersSchema.Type
type Card = NonNullable<VaultList["cards"]>[number]

type PayUse = { readonly kind: "allowed" } | { readonly kind: "ask" } | { readonly kind: "refuse" }

/**
 * Whether the run may go on, must ask on the card, or may not pay. Only the owner allows a
 * payment, on its card: no approval mode and no rule allow one, and with nobody there the card
 * waits in the chat. A read-only run may not pay.
 */
export const payDecision = (input: {
  readonly answered: boolean
  readonly mode: ChatApprovalMode
}): PayUse => {
  if (personCard(input.mode) === "read_only") return { kind: "refuse" }
  return input.answered ? { kind: "allowed" } : { kind: "ask" }
}

const host = (origin: string): string => new URL(origin).host

const amountText = (input: Pick<PayInput, "amount" | "currency">): string => {
  const read = readAmount(input.amount, input.currency)
  if (read.kind !== "ok")
    throw toolRefusal(
      "Give the amount as a plain number above zero with at most the currency's decimals (84.20), and the currency as its three-letter code (USD).",
      "Amount refused"
    )
  return read.text
}

/** "Pay $84.20 at booking.com?" with the card, the shop and the agent's reason. */
export const payCard = (input: PayInput, card: Card): ServerApprovalPrompt => {
  const amount = amountText(input)
  const title = cardTitle(card)
  return {
    preview: `Pay ${amount} at ${host(input.shop)}`,
    presentation: {
      title: `Pay ${amount} at ${host(input.shop)}?`,
      fields: [
        { label: APPROVAL_FIELD_LABEL.card, value: title },
        { label: APPROVAL_FIELD_LABEL.reason, value: input.reason },
        {
          label: APPROVAL_FIELD_LABEL.amount,
          value: `${input.amount.trim()} ${input.currency.toUpperCase()}`
        },
        { label: APPROVAL_FIELD_LABEL.shop, value: input.shop },
        { label: APPROVAL_FIELD_LABEL.tab, value: input.tab_ref },
        { label: APPROVAL_FIELD_LABEL.cardId, value: card.id }
      ],
      approve_label: "Pay with Touch ID",
      reject_label: DECISION_WORD.deny
    },
    data: { reviewer: "user", vault_card_id: card.id }
  }
}

/** "Give your card to pay.example.com?": a payment frame Arden does not know. */
export const frameCard = (
  input: typeof FrameParametersSchema.Type,
  card: Card
): ServerApprovalPrompt => ({
  preview: `Give your card to ${host(input.frame)}`,
  presentation: {
    title: `Give your card to ${host(input.frame)}?`,
    fields: [
      { label: APPROVAL_FIELD_LABEL.card, value: cardTitle(card) },
      { label: APPROVAL_FIELD_LABEL.frame, value: input.frame },
      { label: APPROVAL_FIELD_LABEL.shop, value: input.shop },
      { label: APPROVAL_FIELD_LABEL.tab, value: input.tab_ref },
      { label: APPROVAL_FIELD_LABEL.cardId, value: card.id }
    ],
    approve_label: DECISION_WORD.allowOnce,
    reject_label: DECISION_WORD.deny
  },
  data: { reviewer: "user", vault_card_id: card.id }
})

const findCard = (list: VaultList, id: string): Card => {
  const card = (list.cards ?? []).find((saved) => saved.id === id)
  if (card === undefined)
    throw toolRefusal(
      "No saved card has that id. Check vault_list; if the user has no card saved, tell them they can add one in Settings → Vault.",
      "No such card"
    )
  return card
}

const listOrRefuse = (vault: VaultKeysService): Promise<VaultList> =>
  vault.list().catch(() => {
    throw toolRefusal(
      "Arden could not read its Vault just now. Try again in a moment.",
      "Vault unavailable"
    )
  })

const refuseSecretShaped = (reason: string): void => {
  if (looksLikeSecret(reason) || /[0-9][0-9 -]{11,}[0-9]/.test(reason))
    throw toolRefusal(
      "The reason looks like it holds a secret or a card number. Write it again in plain words.",
      "Reason refused"
    )
}

const READ_ONLY = "This run is read-only, so it may not pay."

/** What the agent is told once the owner paid with Touch ID: how to fill, and what not to do. */
export const paymentAllowed = (card: Card, input: Pick<PayInput, "shop" | "tab_ref">): string =>
  [
    `The user approved the payment with Touch ID. For the next ${APPROVAL_MINUTES} minutes, while ${input.tab_ref} stays on ${input.shop}, Arden types the ${cardTitle(card)} card for you:`,
    `browser_act action fill with card {"id": "${card.id}", "field": ...} and a fresh node_ref, one field at a time: number, expiry (a single field, or the month field and then the year field), security_code, name.`,
    "Fill every other field first (billing address, email): once a card field is typed, Arden types nothing else on that page and takes no screenshot of it. Choose expiry lists with select before the first card field.",
    "You never see the number or the security code. If a field sits in a payment frame Arden does not know, browser_act says so; ask with vault_allow_payment_frame.",
    "Then press the shop's own pay button. If the shop or the bank asks for anything the Vault does not hold (a one-time code, an app confirmation), stop and tell the user; never ask for it in the chat."
  ].join(" ")

const makeVaultPayTool = (
  vault: VaultKeysService,
  browser: BrowserClient["Service"]
): ServerTool => {
  const requireTabOnShop = async (
    input: { readonly shop: string; readonly tab_ref: string },
    run: ServerRunContext,
    signal: AbortSignal
  ) => {
    const tabs = await runBrowserForRun(browser, { run }, { type: "tabs" }, signal)
    if (tabOriginOf(tabs, input.tab_ref) !== input.shop)
      throw toolRefusal(
        "The tab is not on that shop. Check browser_tabs and ask with the tab's current origin.",
        "Shop changed"
      )
  }
  return defineServerTool({
    name: "vault_pay",
    description: [
      "Ask the user to pay at a shop's checkout with one of their saved cards (vault_list lists them by id, brand, last 4 digits and expiry).",
      "The user approves on a card in the chat with Touch ID; a payment always needs them, so with nobody there the card waits.",
      "Call it on the checkout page, once the order and its total are final, with the total and currency the page shows. Arden cannot check the amount against the page, so give exactly what the page says.",
      "Once approved, fill the card's fields with browser_act card; you never see the number or the security code.",
      "Never type a card number or a security code yourself, never ask for one in the chat, and never pay with a card the user did not save."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(PayParametersSchema),
    metadata: {
      display: { card: "vault_card_pay" },
      effect: "none",
      display_name: "Pay with a card",
      kind: "tool",
      action: "read",
      approval_preview: "Pay at a shop with a saved card.",
      source: "_system",
      changes_state: false,
      concurrency_group: "browser",
      destructive: null,
      // No approval_bypass: the card is this call's own requirement, so Never ask does not waive
      // it, and its reviewer is the owner, so Auto's helper does not answer it either.
      policy_scope: "external",
      code_mode: false
    },
    approvalRequirement: async (input, ctx) => {
      refuseSecretShaped(input.reason)
      const card = findCard(await listOrRefuse(vault), input.card_id)
      const decision = payDecision({ answered: false, mode: ctx.run.approvalMode })
      if (decision.kind === "refuse") throw toolRefusal(READ_ONLY, DECISION_WORD.denied)
      await requireTabOnShop(input, ctx.run, ctx.signal)
      return payCard(input, card)
    },
    execute: async (input, ctx) => {
      refuseSecretShaped(input.reason)
      const card = findCard(await listOrRefuse(vault), input.card_id)
      const decision = payDecision({
        answered: ctx.approval?.data?.["vault_card_id"] === card.id,
        mode: ctx.run.approvalMode
      })
      switch (decision.kind) {
        case "refuse":
          throw toolRefusal(READ_ONLY, DECISION_WORD.denied)
        case "ask":
          throw toolRefusal("A payment is allowed only on the user's card.", "Needs approval")
        case "allowed":
          return {
            result: paymentAllowed(card, input),
            preview: `${cardTitle(card)} allowed`,
            data: {
              card_title: cardTitle(card),
              amount: amountText(input),
              shop: host(input.shop)
            }
          }
      }
    }
  })
}

const makeAllowFrameTool = (vault: VaultKeysService): ServerTool =>
  defineServerTool({
    name: "vault_allow_payment_frame",
    description: [
      "Ask the user whether a saved card may be typed into a payment frame from an address Arden does not know, after browser_act refused for that reason and named the frame.",
      "Only during a payment the user approved with vault_pay. The user allows it once or denies; then fill the field again."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(FrameParametersSchema),
    metadata: {
      display: { card: "vault_card_frame" },
      effect: "none",
      display_name: "Payment frame",
      kind: "tool",
      action: "read",
      approval_preview: "Let a payment frame get a saved card.",
      source: "_system",
      changes_state: false,
      concurrency_group: "browser",
      destructive: null,
      policy_scope: "external",
      code_mode: false
    },
    approvalRequirement: async (input, ctx) => {
      const card = findCard(await listOrRefuse(vault), input.card_id)
      if (payDecision({ answered: false, mode: ctx.run.approvalMode }).kind === "refuse")
        throw toolRefusal(READ_ONLY, DECISION_WORD.denied)
      return frameCard(input, card)
    },
    execute: async (input, ctx) => {
      const card = findCard(await listOrRefuse(vault), input.card_id)
      if (ctx.approval?.data?.["vault_card_id"] !== card.id)
        throw toolRefusal("A payment frame is allowed only on the user's card.", "Needs approval")
      return {
        result: `The user allowed ${host(input.frame)} to get the ${cardTitle(card)} card for this payment. Fill the field again.`,
        preview: `${host(input.frame)} allowed`
      }
    }
  })

/** The agent's card tools: ask to pay, and ask about an unknown payment frame. */
export const vaultCardTools = Effect.gen(function* () {
  const vault = yield* VaultKeys
  const browser = yield* BrowserClient
  return [makeVaultPayTool(vault, browser), makeAllowFrameTool(vault)]
})

/** vault_list's lines for cards: safe fields and the id the agent pays with. */
export const cardLines = (list: VaultList): ReadonlyArray<string> =>
  (list.cards ?? []).map(
    (card) =>
      `- ${cardTitle(card)} (id ${card.id}): expires ${card.expiry}, name on card ${card.nameOnCard}${card.billingName === undefined ? "" : `, billing address: ${card.billingName}'s contact details`}`
  )

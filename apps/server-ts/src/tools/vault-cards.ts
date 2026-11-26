import { isLoopbackHost } from "@arden-hq/std/url"
import { cardTitle, readAmount } from "@arden-hq/std/vault-card"
import { APPROVAL_FIELD_LABEL } from "@arden-hq/protocol/chat"
import { DECISION_WORD } from "@arden-hq/protocol/permissions"
import { Effect, Schema } from "effect"

import { BrowserClient, CardFillFieldSchema, CardIdSchema } from "../browser/service.js"
import {
  looksLikeSecret,
  VaultKeys,
  type VaultKeysService,
  type VaultList
} from "../credentials/vault-keys.js"
import { personCard } from "../execution/decide.js"
import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import { tabOriginOf } from "./browser-ask-secret.js"
import {
  claimObservedRevision,
  OriginSchema,
  originIssues,
  ProfileRefSchema,
  runBrowserForRun,
  TabRefSchema
} from "./browser-support.js"
import { nodeRefSchema, SnapshotRefSchema } from "./browser-parameters.js"
import { defineServerTool, type ServerApprovalPrompt, type ServerTool } from "./define.js"
import type { ServerRunContext } from "./run-context.js"
import { toolRefusal } from "./tool-failure.js"

const APPROVAL_MINUTES = 10

const ReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(200))

const shopIssues = (value: string, path: string): Array<Schema.FilterIssue> => {
  if (!URL.canParse(value)) return [{ path: [path], issue: "must be an exact https origin" }]
  const url = new URL(value)
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))
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

const payCard = (input: PayInput, card: Card): ServerApprovalPrompt => {
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

const frameCard = (input: typeof FrameParametersSchema.Type, card: Card): ServerApprovalPrompt => ({
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

const paymentAllowed = (card: Card, input: Pick<PayInput, "shop" | "tab_ref">): string =>
  [
    `The user approved the payment with Touch ID. For the next ${APPROVAL_MINUTES} minutes, while ${input.tab_ref} stays on ${input.shop}, Arden types the ${cardTitle(card)} card for you with vault_checkout.`,
    "Fill every other field of the checkout first (name, address, postcode, email, and any field inside the payment frame that is not the card, such as a postcode there), and choose expiry lists with select. Then take one browser_snapshot.",
    `From that snapshot, call vault_checkout once with card_id "${card.id}", the refs of the card fields (number, expiry, security_code, name: an expiry split in two takes the month field and then the year field) and the ref of the shop's Pay button. Arden types the card and clicks Pay in that one call.`,
    "From the first character typed, the tab belongs to the user: Arden cannot read or use it any more, and you cannot confirm the payment. Ask the user whether it went through, and what the shop says if it asks for anything more (for example a code from the bank). Never claim it succeeded, and never ask for a card number or a code in the chat.",
    "You never see the number or the security code. If a card field sits in a payment frame Arden does not know, vault_checkout says so before typing anything; ask with vault_allow_payment_frame, then call it again."
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
    summary:
      "Asks you to pay at a shop with a saved card, with Touch ID; the agent never sees the card.",
    discovery: { group: "vault" },
    description: [
      "Ask the user to pay at a shop's checkout with one of their saved cards (vault_list lists them by id, brand, last 4 digits and expiry).",
      "The user approves on a card in the chat with Touch ID; a payment always needs them, so with nobody there the card waits.",
      "Call it on the checkout page, once the order and its total are final, with the total and currency the page shows. Arden cannot check the amount against the page, so give exactly what the page says.",
      "Before asking, fill every other field of the checkout (name, address, postcode, any field in the payment frame that is not the card). Once approved, take one snapshot and call vault_checkout with the refs of the card fields and of the Pay button: Arden types the card and clicks Pay in one call. You never see the number or the security code. From then on the tab belongs to the user and Arden cannot read or use it: ask the user whether the payment went through and what the shop asks for, if anything (for example a code from the bank).",
      "Never type a card number or a security code yourself, never ask for one in the chat, and never pay with a card the user did not save."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(PayParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "vault_card_pay" }],
      effect: "none",
      display_name: "Pay with a card",
      kind: "tool",
      action: "read",
      approval_preview: "Pay at a shop with a saved card.",
      source: "_system",
      changes_state: false,
      concurrency_group: "browser",
      destructive: null,
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

export const frameThere = (checked: {
  readonly data?: Record<string, unknown> | undefined
}): boolean => checked.data?.["matches"] === true

const makeAllowFrameTool = (
  vault: VaultKeysService,
  browser: BrowserClient["Service"]
): ServerTool =>
  defineServerTool({
    name: "vault_allow_payment_frame",
    summary: "Asks whether a payment form from an unknown company may get your card.",
    discovery: { group: "vault" },
    description: [
      "Ask the user whether a saved card may be typed into a payment frame from an address Arden does not know, after vault_checkout refused for that reason and named the frame.",
      "Only during a payment the user approved with vault_pay. The user allows it once or denies; then call vault_checkout again."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(FrameParametersSchema),
    metadata: {
      display: [{ fact: "card", value: "vault_card_frame" }],
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
      const checked = await runBrowserForRun(
        browser,
        { run: ctx.run },
        { type: "card_frame", tabRef: input.tab_ref, shop: input.shop, frame: input.frame },
        ctx.signal
      )
      if (!frameThere(checked))
        throw toolRefusal(
          `The focused card field is not in a frame from ${input.frame} placed directly in ${input.shop}. Ask only about the frame vault_checkout names.`,
          "Frame not found"
        )
      return frameCard(input, card)
    },
    execute: async (input, ctx) => {
      const card = findCard(await listOrRefuse(vault), input.card_id)
      if (ctx.approval?.data?.["vault_card_id"] !== card.id)
        throw toolRefusal("A payment frame is allowed only on the user's card.", "Needs approval")
      return {
        result: `The user allowed ${host(input.frame)} to get the ${cardTitle(card)} card for this payment. Call vault_checkout again.`,
        preview: `${host(input.frame)} allowed`
      }
    }
  })

export const CheckoutParametersSchema = Schema.Struct({
  tab_ref: TabRefSchema.annotate({ description: "The checkout's tab, as on vault_pay." }),
  profile_ref: ProfileRefSchema.annotate({
    description: "The tab's profile_ref from its snapshot."
  }),
  origin: OriginSchema.annotate({ description: "The shop's exact origin, as on vault_pay." }),
  snapshot_ref: SnapshotRefSchema,
  card_id: CardIdSchema.annotate({ description: "The card's id, as on vault_pay." }),
  fields: Schema.Array(
    Schema.Struct({
      node_ref: nodeRefSchema("The card field's ref in that snapshot."),
      field: CardFillFieldSchema.annotate({
        description:
          "Which of the card's fields it is: number, expiry (one field, or the month and then the year field), security_code, or name."
      })
    })
  )
    .check(Schema.isMinLength(1), Schema.isMaxLength(6))
    .annotate({ description: "The card fields, in the order to type them." }),
  pay_node_ref: nodeRefSchema("The ref of the shop's own Pay button in that snapshot.")
}).check(Schema.makeFilter((input) => originIssues(input.origin)))

const makeCheckoutTool = (browser: BrowserClient["Service"]): ServerTool =>
  defineServerTool({
    name: "vault_checkout",
    summary: "Types your saved card into the checkout and clicks Pay; the agent never sees it.",
    discovery: { group: "vault" },
    description: [
      "Type a saved card into the checkout and click the shop's Pay button, in one call, after the user approved vault_pay for this card and this tab.",
      "Take one browser_snapshot after every other field is filled; give the refs of the card fields and of the Pay button from it. Arden checks every card field before typing any, then types them and clicks Pay; you never see the number or the security code.",
      "From the first character typed, the tab belongs to the user: Arden cannot read or use it any more, only close it. Then ask the user whether the payment went through, and what the shop says if it asks for anything more (for example a code from the bank). Never claim the payment succeeded."
    ].join(" "),
    parameters: Schema.toStandardSchemaV1(CheckoutParametersSchema),
    metadata: {
      effect: "external",
      display_name: "Pay at the shop",
      kind: "browser",
      action: "execute",
      approval_preview: "Type the saved card and click Pay.",
      source: "_browser",
      changes_state: true,
      target: "reported",
      concurrency_group: "browser",
      destructive: false,
      approval_bypass: true,
      policy_scope: "external",
      open_world: true,
      code_mode: false
    },
    execute: async (input, ctx, effects) => {
      const expectedRevision = claimObservedRevision(
        ctx.run.browserObservations,
        input.tab_ref,
        input.snapshot_ref,
        ctx.toolCallId
      )
      const output = await runBrowserForRun(
        browser,
        ctx,
        {
          type: "card_checkout",
          tabRef: input.tab_ref,
          profileRef: input.profile_ref,
          origin: input.origin,
          expectedRevision,
          card: input.card_id,
          fields: input.fields.map((item) => ({ nodeRef: item.node_ref, field: item.field })),
          payRef: input.pay_node_ref
        },
        ctx.signal,
        { effects }
      )
      return { result: output.result, preview: output.preview }
    }
  })

export const vaultCardTools = Effect.gen(function* () {
  const vault = yield* VaultKeys
  const browser = yield* BrowserClient
  return [
    makeVaultPayTool(vault, browser),
    makeAllowFrameTool(vault, browser),
    makeCheckoutTool(browser)
  ]
})

export const cardLines = (list: VaultList): ReadonlyArray<string> =>
  (list.cards ?? []).map(
    (card) =>
      `- ${cardTitle(card)} (id ${card.id}): expires ${card.expiry}, name on card ${card.nameOnCard}${card.billingName === undefined ? "" : `, billing address: ${card.billingName}'s contact details`}`
  )

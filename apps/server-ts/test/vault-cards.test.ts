import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { makeVaultKeys, type VaultKeyBroker } from "../src/credentials/vault-keys.js"
import { ActParametersSchema } from "../src/tools/browser-parameters.js"
import {
  CheckoutParametersSchema,
  frameCard,
  frameThere,
  payCard,
  payDecision,
  paymentAllowed
} from "../src/tools/vault-cards.js"
import { vaultListText } from "../src/tools/vault.js"

const CARD = {
  id: "0123456789abcdef01234567",
  brand: "Visa",
  last4: "4242",
  expiry: "08/28",
  nameOnCard: "Alex Morgan",
  billingName: "Alex Morgan"
} as const

const desktop = (cards: ReadonlyArray<unknown>): VaultKeyBroker => ({
  listVault: async () => ({ keys: [], passwords: [], contacts: [], cards }),
  keyEnvironment: async () => ({
    variables: {},
    missing: [],
    proxyUrl: "",
    caFile: "",
    caBundleFile: ""
  }),
  findSecrets: async () => ({ ranges: [] }),
  endKeySession: async () => ({ ended: true })
})

const PAY = {
  card_id: CARD.id,
  amount: "84.20",
  currency: "usd",
  shop: "https://booking.com",
  tab_ref: "tab-1",
  reason: "You asked me to book the Lisbon hotel for 12 December."
}

describe("cards seen from the engine", () => {
  it("vault_list gives the safe fields and the id, never a number or a code", async () => {
    const list = await makeVaultKeys(desktop([CARD])).list()
    const text = vaultListText(list)
    expect(text.result).toContain(
      "- Visa ending 4242 (id 0123456789abcdef01234567): expires 08/28, name on card Alex Morgan, billing address: Alex Morgan's contact details"
    )
    expect(text.preview).toBe("0 keys, 0 passwords, 0 contacts, 1 card")
    expect(text.result).not.toMatch(/4242 ?4242/)
  })

  it("refuses a list whose card carries its number or security code", async () => {
    for (const leak of [
      { number: "4242424242424242" },
      { securityCode: "123" },
      { last4: "4242424242424242" },
      { brand: "4242424242424242" },
      { expiry: "4242424242424242" }
    ]) {
      await expect(makeVaultKeys(desktop([{ ...CARD, ...leak }])).list()).rejects.toThrow()
    }
  })

  it("a payment always needs the owner: never asked away, refused read-only", () => {
    expect(payDecision({ answered: false, mode: "ask" })).toEqual({ kind: "ask" })
    expect(payDecision({ answered: false, mode: "never_ask" })).toEqual({ kind: "ask" })
    expect(payDecision({ answered: false, mode: "auto" })).toEqual({ kind: "ask" })
    expect(payDecision({ answered: true, mode: "ask" })).toEqual({ kind: "allowed" })
    expect(payDecision({ answered: true, mode: "read_only" })).toEqual({ kind: "refuse" })
  })

  it("the pay card names the amount, the shop and the card, with Pay with Touch ID and Deny", () => {
    const card = payCard(PAY, CARD)
    expect(card.presentation.title).toBe("Pay $84.20 at booking.com?")
    expect(card.presentation.approve_label).toBe("Pay with Touch ID")
    expect(card.presentation.reject_label).toBe("Deny")
    expect(card.presentation.fields).toEqual([
      { label: "Card", value: "Visa ending 4242" },
      { label: "For", value: PAY.reason },
      { label: "Amount", value: "84.20 USD" },
      { label: "Shop", value: "https://booking.com" },
      { label: "Tab", value: "tab-1" },
      { label: "Card id", value: CARD.id }
    ])
    expect(() => payCard({ ...PAY, amount: "84.205" }, CARD)).toThrow(/Amount|amount/)
  })

  it("the frame card asks to give the card to an unknown payment company", () => {
    const card = frameCard(
      { card_id: CARD.id, frame: "https://pay.example.com", shop: PAY.shop, tab_ref: "tab-1" },
      CARD
    )
    expect(card.presentation.title).toBe("Give your card to pay.example.com?")
    expect(card.presentation.approve_label).toBe("Allow once")
  })

  it("the frame card is raised only when the desktop found the card field in that frame", () => {
    expect(frameThere({ data: { matches: true } })).toBe(true)
    expect(frameThere({ data: { matches: false } })).toBe(false)
    expect(frameThere({ data: { matches: "true" } })).toBe(false)
    expect(frameThere({})).toBe(false)
  })

  it("once paid, the agent is told how to fill and to stop at a bank's code", () => {
    const text = paymentAllowed(CARD, PAY)
    expect(text).toContain('call vault_checkout once with card_id "0123456789abcdef01234567"')
    expect(text).toContain("10 minutes")
    expect(text).toContain("one-time code")
    expect(text).toContain("never ask for it in the chat")
    expect(text).toContain("Fill every other field of the checkout first")
    expect(text).toContain("stop and tell the user what the shop asks for")
  })

  it("browser_act takes no card; vault_checkout takes card fields and the Pay button by ref, never a value", () => {
    const act = {
      tab_ref: "tab-1",
      profile_ref: "default",
      origin: "https://booking.com",
      snapshot_ref: "snap-0123456789ab",
      target: { node_ref: "@e3" }
    }
    const decodeAct = Schema.decodeUnknownSync(ActParametersSchema)
    expect(decodeAct({ ...act, action: "fill", value: "x" })).not.toHaveProperty("card")
    expect(
      decodeAct({ ...act, action: "fill", value: "x", card: { id: CARD.id, field: "number" } })
    ).not.toHaveProperty("card")
    const decode = Schema.decodeUnknownSync(CheckoutParametersSchema)
    const checkout = {
      tab_ref: "tab-1",
      profile_ref: "default",
      origin: "https://booking.com",
      snapshot_ref: "snap-0123456789ab",
      card_id: CARD.id,
      fields: [
        { node_ref: "e4", field: "number" },
        { node_ref: "@e6", field: "security_code" }
      ],
      pay_node_ref: "e9"
    }
    expect(decode(checkout)).toMatchObject({
      fields: [
        { node_ref: "@e4", field: "number" },
        { node_ref: "@e6", field: "security_code" }
      ],
      pay_node_ref: "@e9"
    })
    expect(() => decode({ ...checkout, fields: [] })).toThrow()
    expect(() => decode({ ...checkout, fields: [{ node_ref: "@e4", field: "pin" }] })).toThrow()
    expect(() =>
      decode({ ...checkout, fields: [{ node_ref: "@e4", field: "number", value: "4242" }] })
    ).not.toThrow()
    expect(
      decode({ ...checkout, fields: [{ node_ref: "@e4", field: "number", value: "4242" }] })
        .fields[0]
    ).not.toHaveProperty("value")
  })
})

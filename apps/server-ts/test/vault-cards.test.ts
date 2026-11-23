import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { makeVaultKeys, type VaultKeyBroker } from "../src/credentials/vault-keys.js"
import { ActParametersSchema } from "../src/tools/browser-parameters.js"
import { CheckoutParametersSchema, frameThere, payDecision } from "../src/tools/vault-cards.js"

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

describe("cards seen from the engine", () => {
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

  it("the frame card is raised only when the desktop found the card field in that frame", () => {
    expect(frameThere({ data: { matches: true } })).toBe(true)
    expect(frameThere({ data: { matches: false } })).toBe(false)
    expect(frameThere({ data: { matches: "true" } })).toBe(false)
    expect(frameThere({})).toBe(false)
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

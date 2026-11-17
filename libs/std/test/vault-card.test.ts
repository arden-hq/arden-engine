import { describe, expect, test } from "vitest"
import {
  cardBrand,
  cardNumberSpellings,
  cardSafeFields,
  cardTitle,
  passesLuhn,
  readAmount,
  readCard,
  readCardChange,
  readExpiry
} from "../src/vault-card.js"

const NOW = new Date(2026, 10, 17)

describe("card rules", () => {
  test("Luhn: the published test numbers pass, a changed digit fails", () => {
    expect(
      ["4242424242424242", "5555555555554444", "378282246310005", "4242424242424241", "0"].map(
        passesLuhn
      )
    ).toEqual([true, true, true, false, true])
    expect(passesLuhn("42a2")).toBe(false)
  })

  test("the brand comes from the prefix", () => {
    expect(
      [
        "4242424242424242",
        "5555555555554444",
        "2223003122003222",
        "378282246310005",
        "6011111111111117"
      ].map(cardBrand)
    ).toEqual(["Visa", "Mastercard", "Mastercard", "American Express", "Card"])
  })

  test("a new card: every field checked at once, spaces in the number allowed", () => {
    expect(
      readCard(
        {
          number: "4242 4242 4242 4242",
          expiry: "08 / 28",
          securityCode: "123",
          nameOnCard: "  Alex   Morgan ",
          billingContactId: ""
        },
        NOW
      )
    ).toEqual({
      kind: "ok",
      card: {
        number: "4242424242424242",
        expiry: { month: 8, year: 2028 },
        securityCode: "123",
        nameOnCard: "Alex Morgan"
      }
    })
    expect(
      readCard(
        {
          number: "4242 4242 4242 4241",
          expiry: "10/26",
          securityCode: "1234",
          nameOnCard: "",
          billingContactId: "nope"
        },
        NOW
      )
    ).toEqual({
      kind: "refused",
      issues: {
        number: "not_valid",
        expiry: "expired",
        securityCode: "not_code",
        nameOnCard: "missing",
        billingContactId: "not_valid"
      }
    })
  })

  test("the security code is 4 digits for American Express and 3 otherwise", () => {
    const code = (number: string, securityCode: string) => {
      const read = readCard({ number, expiry: "08/28", securityCode, nameOnCard: "A" }, NOW)
      return read.kind === "ok" ? "ok" : read.issues.securityCode
    }
    expect(code("378282246310005", "1234")).toBe("ok")
    expect(code("378282246310005", "123")).toBe("not_code")
    expect(code("4242424242424242", "123")).toBe("ok")
    expect(code("4242424242424242", "1234")).toBe("not_code")
  })

  test("expiry shapes and this month", () => {
    expect(
      ["08/28", "8/28", "08 / 28", "08/2028", "13/28", "0828"].map((typed) => readExpiry(typed))
    ).toEqual([
      { month: 8, year: 2028 },
      { month: 8, year: 2028 },
      { month: 8, year: 2028 },
      { month: 8, year: 2028 },
      undefined,
      undefined
    ])
    expect(readCardChange({ expiry: "11/26", nameOnCard: "A" }, NOW).kind).toBe("ok")
    expect(readCardChange({ expiry: "10/26", nameOnCard: "A" }, NOW)).toEqual({
      kind: "refused",
      issues: { expiry: "expired" }
    })
  })

  test("the safe fields and title never hold the number or the code", () => {
    const safe = cardSafeFields({
      number: "4242424242424242",
      expiry: { month: 8, year: 2028 },
      securityCode: "123",
      nameOnCard: "Alex Morgan"
    })
    expect(safe).toEqual({
      brand: "Visa",
      last4: "4242",
      expiry: "08/28",
      nameOnCard: "Alex Morgan"
    })
    expect(cardTitle(safe)).toBe("Visa ending 4242")
  })

  test("every spelling of the number: plain, groups of four, Amex grouping, spaces or dashes", () => {
    expect(cardNumberSpellings("4242424242424242")).toEqual([
      "4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242"
    ])
    expect(cardNumberSpellings("378282246310005")).toEqual([
      "378282246310005",
      "3782 8224 6310 005",
      "3782-8224-6310-005",
      "3782 822463 10005",
      "3782-822463-10005"
    ])
  })

  test("amounts read in their currency", () => {
    expect(readAmount("84.20", "USD")).toEqual({ kind: "ok", text: "$84.20" })
    expect(readAmount("84.2", "eur")).toEqual({ kind: "ok", text: "€84.20" })
    expect(readAmount("1200", "JPY")).toEqual({ kind: "ok", text: "¥1,200" })
    expect(
      ["0", "-1", "1.234", "1e3", "84.20 "].map((amount) => readAmount(amount, "USD").kind)
    ).toEqual(["refused", "refused", "refused", "refused", "ok"])
    expect(readAmount("1.5", "JPY").kind).toBe("refused")
    expect(readAmount("1", "XQQ").kind).toBe("refused")
  })
})

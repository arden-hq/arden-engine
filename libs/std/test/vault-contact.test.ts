import { describe, expect, test } from "vitest"
import { addressLine, readContact } from "../src/vault-contact.js"

describe("contact rules", () => {
  test("only Name is required; blanks are left out and spaces tidied", () => {
    expect(readContact({ name: "  Alex   Morgan ", email: " ", city: "Bristol" })).toEqual({
      kind: "ok",
      contact: { name: "Alex Morgan", city: "Bristol" }
    })
    expect(readContact({ email: "alex@example.com" })).toEqual({
      kind: "refused",
      field: "name",
      issue: "missing"
    })
  })

  test("email and phone are checked lightly", () => {
    const issue = (field: "email" | "phone", value: string) => {
      const read = readContact({ name: "A", [field]: value })
      return read.kind === "ok" ? "ok" : read.issue
    }
    expect(
      ["alex@example.com", "a@b", "alex.example.com", "alex @x.com", "@x.com"].map((value) =>
        issue("email", value)
      )
    ).toEqual(["ok", "ok", "not_email", "not_email", "not_email"])
    expect(
      ["+44 20 7946 0958", "(555) 123-4567", "555 CALL NOW", "+-()"].map((value) =>
        issue("phone", value)
      )
    ).toEqual(["ok", "ok", "not_phone", "not_phone"])
  })

  test("refuses a field too long, on two lines, or not text", () => {
    expect(readContact({ name: "A", postalCode: "1".repeat(33) })).toEqual({
      kind: "refused",
      field: "postalCode",
      issue: "too_long"
    })
    expect(readContact({ name: "A", postalCode: "1".repeat(32) }).kind).toBe("ok")
    expect(readContact({ name: "A", addressLine1: "12 Marsh\nLane" })).toEqual({
      kind: "refused",
      field: "addressLine1",
      issue: "not_one_line"
    })
    expect(readContact({ name: "A", city: 7 })).toEqual({
      kind: "refused",
      field: "city",
      issue: "not_one_line"
    })
  })

  test("the address reads on one line and ends with the country", () => {
    expect(
      addressLine({
        name: "Alex Morgan",
        addressLine1: "12 Marsh Lane",
        addressLine2: "Flat 2",
        city: "Bristol",
        postalCode: "BS1 4DJ",
        region: "England",
        country: "United Kingdom"
      })
    ).toBe("12 Marsh Lane, Flat 2, Bristol BS1 4DJ, England, United Kingdom")
    expect(addressLine({ name: "A", postalCode: "10115", country: "Germany" })).toBe(
      "10115, Germany"
    )
    expect(addressLine({ name: "A" })).toBe("")
  })
})

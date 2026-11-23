import { expect, it } from "vitest"
import { usageMoney } from "../src/tools/usage-money.js"

const cell = (cost: number | undefined) => ({ ...(cost === undefined ? {} : { cost }) })

it("states the money a usage window cost only when every call's provider reported it", () => {
  expect(usageMoney([cell(0.25), cell(0.5)])).toMatchObject({ state: "reported", usd: 0.75 })
  const partial = usageMoney([cell(0.25), cell(undefined)])
  expect(partial.state).toBe("unavailable")
  expect(partial).not.toHaveProperty("usd")
  const empty = usageMoney([])
  expect(empty.state).toBe("unavailable")
  expect(empty).not.toHaveProperty("usd")
})

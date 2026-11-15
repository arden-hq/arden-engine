import { expect, it } from "vitest"
import { usageMoney } from "../src/tools/usage-money.js"

const cell = (cost: number | undefined) => ({ ...(cost === undefined ? {} : { cost }) })

it("states the money a usage window cost only when every call's provider reported it", () => {
  expect(usageMoney([cell(0.25), cell(0.5)])).toEqual({
    state: "reported",
    usd: 0.75,
    reason:
      "What the model providers reported charging for every recorded call (OpenRouter reports it). Not a subscription's limits."
  })
  expect(usageMoney([cell(0.25), cell(undefined)])).toEqual({
    state: "unavailable",
    reason:
      "Some recorded calls' providers report no cost (Codex, llama.cpp), so this report measures tokens, not billed cost or subscription limits."
  })
  expect(usageMoney([])).toEqual({
    state: "unavailable",
    reason: "No recorded calls in this window."
  })
})

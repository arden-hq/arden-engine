import { isRecord } from "@arden-hq/std/json"

/**
 * The spend a response's usage object reports, in US dollars, in the shape
 * OpenRouter defines and gateways in front of it copy (prime `reported_cost`;
 * https://openrouter.ai/docs/guides/guides/usage-accounting, which calls the
 * unit credits: one credit is one dollar). Read the same on Chat Completions
 * and Responses, where OpenRouter reports it alike.
 *
 * - `cost` is what was charged to the account's credits. Live on 2026-11-16 it
 *   equalled `cost_details.upstream_inference_cost` on every non-BYOK
 *   response, and a free model's 0 is a reported 0.
 * - With the person's own provider key (`is_byok: true`), `cost` is only
 *   OpenRouter's fee, and the provider bills `upstream_inference_cost`
 *   separately: the spend is their sum, and unknown without the upstream bill.
 *
 * Undefined when the usage names no cost: llama.cpp and Codex report none.
 */
export const reportedCost = (usage: Readonly<Record<string, unknown>>): number | undefined => {
  const charged = dollars(usage.cost)
  if (usage.is_byok !== true) return charged
  const details = isRecord(usage.cost_details) ? usage.cost_details : {}
  const upstream = dollars(details.upstream_inference_cost)
  return upstream === undefined ? undefined : upstream + (charged ?? 0)
}

const dollars = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined

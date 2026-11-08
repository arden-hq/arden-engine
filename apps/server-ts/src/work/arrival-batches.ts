import type { RunDelivery } from "../persistence/deliveries/model.js"

export const arrivalBatches = (
  deliveries: ReadonlyArray<RunDelivery>
): ReadonlyArray<ReadonlyArray<RunDelivery>> => {
  const sessions = new Map<string, Array<RunDelivery>>()
  for (const delivery of deliveries) {
    const batch = sessions.get(delivery.payload.sessionId)
    if (batch === undefined) sessions.set(delivery.payload.sessionId, [delivery])
    else batch.push(delivery)
  }
  return [...sessions.values()]
}

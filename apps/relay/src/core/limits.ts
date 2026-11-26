export const Limits = {
  authTimeoutMs: 10_000,
  pairingTimeoutMs: 5 * 60_000,
  staleMs: 60_000,
  alarmMs: 30_000,
  queueRows: 256,
  queueBytes: 2 * 1024 * 1024,
  queueTtlMs: 24 * 60 * 60_000,
  pairOffers: 8,
  pairOfferTtlMs: 60 * 60_000,
  devices: 32,
  leftTtlMs: 90 * 24 * 60 * 60_000
} as const

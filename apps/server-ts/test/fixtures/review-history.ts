import { Schema } from "effect"

import { SpaceReviewInputSchema } from "../../src/persistence/automations/space-review.js"
import { todayReviewInput } from "../../src/persistence/migrations/0166_retired_memory_records.js"

/**
 * A stored Space review input read with today's schema. A finished run's input keeps the shape
 * it was sent in, so a replay maps a retired shape the way migration 0166 maps the inputs a
 * server path reads.
 */
export const decodeStoredReviewInput = (json: string): typeof SpaceReviewInputSchema.Type =>
  Schema.decodeUnknownSync(SpaceReviewInputSchema)(todayReviewInput(JSON.parse(json)))

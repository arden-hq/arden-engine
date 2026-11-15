import { Schema } from "effect"

import { SpaceReviewInputSchema } from "../../src/persistence/automations/space-review.js"
import { todayReviewInput } from "../../src/persistence/migrations/0166_retired_memory_records.js"

export const decodeStoredReviewInput = (json: string): typeof SpaceReviewInputSchema.Type =>
  Schema.decodeUnknownSync(SpaceReviewInputSchema)(todayReviewInput(JSON.parse(json)))

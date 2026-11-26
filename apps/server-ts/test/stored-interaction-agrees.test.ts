import type {
  InteractionActor,
  InteractionKind,
  InteractionOutcome,
  InteractionRecipient,
  InteractionReference
} from "@arden-hq/loop"
import { expectTypeOf, it } from "vitest"
import {
  StoredActorSchema,
  StoredRecipientSchema,
  StoredReferenceSchema,
  type StoredInteractionSender
} from "../src/persistence/transcript/interaction.js"

it("keeps the stored interaction shapes in step with the loop's", () => {
  expectTypeOf<(typeof StoredActorSchema)["Type"]>().toEqualTypeOf<InteractionActor>()
  expectTypeOf<(typeof StoredRecipientSchema)["Type"]>().toEqualTypeOf<InteractionRecipient>()
  expectTypeOf<(typeof StoredReferenceSchema)["Type"]>().toEqualTypeOf<InteractionReference>()
  expectTypeOf<StoredInteractionSender["kind"]>().toEqualTypeOf<InteractionKind>()
  expectTypeOf<
    Extract<StoredInteractionSender, { readonly outcome: unknown }>["outcome"]
  >().toEqualTypeOf<InteractionOutcome>()
})

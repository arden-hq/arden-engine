import type { Effect, Scope } from "effect"

import type { ChatEventStore } from "../../src/persistence/events/store.js"
import type { SessionLifecycleEvents } from "../../src/persistence/sessions/events.js"
import type { SessionStore } from "../../src/persistence/sessions/store.js"
import type { UnitOfWork } from "../../src/persistence/unit-of-work.js"

export interface ContractPorts {
  readonly sessions: SessionStore["Service"]
  readonly sessionEvents: SessionLifecycleEvents["Service"]
  readonly chatEvents: ChatEventStore["Service"]
  readonly transact: <A, E>(work: Effect.Effect<A, E, UnitOfWork>) => Effect.Effect<A, unknown>
}

export interface ContractBackend {
  readonly name: string
  readonly run: <A>(
    test: (ports: ContractPorts) => Effect.Effect<A, unknown, Scope.Scope>
  ) => Promise<A>
}

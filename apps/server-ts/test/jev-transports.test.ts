import { Effect, Layer, Redacted } from "effect"
import { expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import type { DecisionEndpoint } from "../src/models/decisions/endpoint.js"
import { systemOneFormatBackend } from "../src/models/decisions/systemone-format.js"
import { Decisions } from "../src/models/decisions/service.js"
import { DecisionEndpointSource } from "../src/models/decisions/source.js"
import { StructuredCompletion } from "../src/models/structured-completion.js"
import { UsageStore } from "../src/persistence/usage/store.js"
import { decisionVisionProbe, readsProbeImages } from "../src/models/decisions/vision-probe.js"
import type { DecisionInput } from "../src/models/decisions/questions.js"
import { openrouterDecisionTransport } from "../src/persistence/migrations/0107_openrouter_decision_transport.js"
import { partialService } from "./kit.js"

const request = (): DecisionInput => ({
  instructions: "Inspect the image.",
  state: {},
  images: decisionVisionProbe().images,
  questions: {
    target: { kind: "box", image: 1, instructions: "The red rectangle" },
    present: { kind: "predicate", instructions: "There is a red rectangle in the second image" }
  },
  usage: { kind: "chat_triage", owner: { type: "none" } }
})
const reply = {
  answers: {
    target: {
      type: "box",
      box: { top: 0.25, bottom: 0.75, left: 0.5625, right: 0.9375 },
      confidence: 0.99
    },
    present: { type: "noul", noul: 0.99 }
  }
}
const endpoint = (
  format: DecisionEndpoint["format"],
  fetch: typeof globalThis.fetch
): DecisionEndpoint => ({
  id: "test",
  format,
  baseUrl: "https://example.test/api",
  model: "jev-1.14.0",
  input: "text+image",
  auth: { kind: "bearer", apiKey: Redacted.make("secret") },
  timeoutMs: 1000,
  fetch
})

it.each(["systemone", "openrouter-decisions"] as const)(
  "%s carries actual images and decodes image-bound boxes through Decisions.classify",
  async (format) => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = []
    const configured = endpoint(format, async (url, init) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body)
      })
      return Response.json(reply)
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const decisions = yield* Decisions
        return yield* decisions.classify(request())
      }).pipe(
        Effect.provide(Decisions.layer),
        Effect.provide(
          Layer.merge(
            Layer.succeed(DecisionEndpointSource, {
              current: () => Effect.succeed({ endpoint: configured, origin: "endpoint" }),
              report: () => Effect.void
            }),
            Layer.succeed(
              StructuredCompletion,
              partialService<StructuredCompletion["Service"]>("StructuredCompletion", {
                run: () => Effect.die("must not use Helper")
              })
            )
          )
        ),
        Effect.provide(
          Layer.succeed(
            UsageStore,
            partialService<UsageStore["Service"]>("UsageStore", {
              recordModelCall: () => Effect.void
            })
          )
        )
      )
    )
    expect(result.answers.target).toEqual({
      kind: "box",
      image: 1,
      box: { top: 0.25, bottom: 0.75, left: 0.5625, right: 0.9375 },
      confidence: 0.99
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error("Missing provider request")
    expect(call.headers.get("authorization")).toBe("Bearer secret")
    if (format === "systemone") {
      expect(call.url).toBe("https://example.test/api/v1/systemone")
      expect(call.headers.get("typesafe-danger-zone-images")).toBe("true")
      const body = JSON.parse(call.body)
      expect(body.state.images).toHaveLength(2)
      expect(body.assets[body.state.images[0]]).toEqual({
        type: "image",
        format: "png",
        data_base64: request().images[0]?.data
      })
      expect(body.assets[body.state.images[1]]).toEqual({
        type: "image",
        format: "png",
        data_base64: request().images[1]?.data
      })
    } else {
      expect(call.url).toBe("https://example.test/api/alpha/decisions")
      expect(call.headers.get("typesafe-danger-zone-images")).toBeNull()
      expect(JSON.parse(call.body).state).toEqual([
        { task: "Inspect the image.", state: {} },
        ...request().images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${image.data}` }
        }))
      ])
    }
  }
)

it.each([
  { top: 0.5, bottom: 0.4, left: 0, right: 1 },
  { top: 0, bottom: 1, left: -0.1, right: 1 },
  { top: 0, bottom: 1, left: 0.5, right: 0.5 }
])("rejects malformed provider box %j", async (box) => {
  const backend = systemOneFormatBackend(
    endpoint("systemone", async () =>
      Response.json({ answers: { ...reply.answers, target: { ...reply.answers.target, box } } })
    )
  )
  expect(await Effect.runPromise(Effect.flip(backend.classify(request())))).toMatchObject({
    reason: "invalid_output"
  })
})

it("refuses missing image references before transmitting and does not treat a blind response as vision", async () => {
  const backend = systemOneFormatBackend(
    endpoint("systemone", async () => {
      throw new Error("must not transmit")
    })
  )
  expect(
    await Effect.runPromise(Effect.flip(backend.classify({ ...request(), images: [] })))
  ).toMatchObject({ reason: "invalid_request" })
  expect(
    readsProbeImages({
      backend: "blind",
      answers: {
        ready: {
          kind: "predicate",
          value: true,
          distribution: { kind: "calibrated", probabilities: { true: 1, false: 0 }, confidence: 1 }
        }
      }
    })
  ).toBe(false)
})

it("converts saved OpenRouter transports once, preserving the model, auth and unrelated settings", () => {
  const db = new DatabaseSync(":memory:")
  try {
    db.exec("CREATE TABLE monitor_state (namespace TEXT PRIMARY KEY, state TEXT NOT NULL)")
    const original = {
      decision: {
        format: "systemone",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "typesafe/jev-1.13",
        input: "text+image",
        auth: { kind: "bearer" }
      },
      search: null,
      decisionSource: "endpoint"
    }
    db.prepare("INSERT INTO monitor_state VALUES (?, ?)").run(
      "model_endpoint_settings",
      JSON.stringify(original)
    )
    openrouterDecisionTransport.up(db)
    openrouterDecisionTransport.up(db)
    expect(db.prepare("SELECT state FROM monitor_state").get()).toEqual({
      state: JSON.stringify({
        ...original,
        decision: {
          ...original.decision,
          format: "openrouter-decisions",
          baseUrl: "https://openrouter.ai/api",
          input: "text"
        }
      })
    })
  } finally {
    db.close()
  }
})

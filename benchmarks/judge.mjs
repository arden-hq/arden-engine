import { modelSettings, readProfile } from "./profile.mjs"
import { modelsFor } from "../apps/server-ts/dist/serve/models.js"
import { parseSettings } from "../apps/server-ts/dist/serve/settings.js"

const profile = await readProfile(process.argv[2])
let input = ""
for await (const chunk of process.stdin) input += chunk
const messages = JSON.parse(input)
// The judge is one plain model call, not an Arden trial: it takes the provider
// Arden itself would build from the profile, and starts no server.
const { provider } = await modelsFor(
  parseSettings({ dataDirectory: "/judge-starts-no-server", ...modelSettings(profile) }),
  { env: process.env, fetch: globalThis.fetch }
)
let completion
for await (const item of provider.stream({
  messages: [{ role: "system", content: "" }, ...messages],
  // A judge prompt is plain text; no message carries an interaction to render.
  renderInteraction: () => "",
  model: profile.model,
  tools: [],
  deferredTools: [],
  toolChoice: "none",
  reasoningEffort: profile.reasoningEffort ?? undefined,
  signal: AbortSignal.timeout(profile.timeoutMs)
})) {
  if (typeof item === "object" && item !== null && item._tag === "Completed") completion = item
}
const text = completion?.message.content
if (typeof text !== "string" || !text.trim()) throw new Error("Judge returned no text")
process.stdout.write(JSON.stringify({ text, usage: completion.usage }))

import { readProfile } from "./profile.mjs"
import { benchmarkProvider } from "./provider.mjs"

const profile = await readProfile(process.argv[2])
let input = ""
for await (const chunk of process.stdin) input += chunk
const messages = JSON.parse(input)
const { provider } = await benchmarkProvider(profile)
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

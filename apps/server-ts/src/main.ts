import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { layerFromEnv, ServerConfig } from "./config/service.js"
import { serverLayer } from "./http/server.js"
import { decodeModelHostSource } from "./models/host.js"
import { loadCodexCliRuntime } from "./providers/openai-codex/cli-runtime.js"
import { resolveLoginShellPath } from "./runtime/login-shell-path.js"
import { resolveCommandSandbox } from "./runtime/command-sandbox.js"
import { runConfigured } from "./serve/main.js"

void resolveLoginShellPath()
void resolveCommandSandbox()

const configFlag = process.argv.indexOf("--config")

const MainLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const runtime = yield* Effect.promise(loadCodexCliRuntime)
    if (runtime === undefined) return serverLayer(config)
    return serverLayer(config, {
      provider: runtime.provider,
      modelHost: yield* decodeModelHostSource(runtime.modelHost),
      refreshModelHost: runtime.refreshModelHost,
      approvalReview: runtime.approvalReview,
      planLimits: runtime.planLimits,
      transcription: runtime.transcription
    })
  }).pipe(Effect.provide(layerFromEnv))
)

// `--config <file>` starts with every setting of the file in place; without
// it the server reads its few options from the environment, as before.
if (configFlag === -1) Layer.launch(MainLayer).pipe(NodeRuntime.runMain)
else void runConfigured(process.argv[configFlag + 1])

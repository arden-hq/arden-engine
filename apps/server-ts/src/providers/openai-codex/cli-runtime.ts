import { codexCliCredentials, CodexLoginError } from "./cli-login.js"
import { makeOpenAiCodexRuntime, type OpenAiCodexRuntime } from "./runtime.js"

const NO_LOGIN = "No model provider: run `codex login`, then start the server again."

export const loadCodexCliRuntime = async (): Promise<OpenAiCodexRuntime | undefined> => {
  const credentials = codexCliCredentials()
  try {
    const runtime = await makeOpenAiCodexRuntime({
      credentials,
      initialCredential: await credentials.get({ signal: AbortSignal.timeout(5_000) })
    })
    if (runtime === null) console.error(NO_LOGIN)
    return runtime ?? undefined
  } catch (error) {
    if (!(error instanceof CodexLoginError)) throw error
    console.error(`${NO_LOGIN} (${error.message})`)
    return undefined
  }
}

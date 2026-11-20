import {
  resolveModelCapabilities,
  type ModelProvider,
  MODEL_PROVIDER_PROTOCOL
} from "@arden-hq/loop"
import { Effect } from "effect"
import type { ModelProviderOptions } from "../config/options.js"
import type { ApprovalReviewSource, TranscriptionSource } from "../models/provider.js"
import type { ModelHost } from "../models/host.js"
import type { PlanLimitsSource } from "../models/plan-limits.js"
import { makeOpenAiCodexRuntime } from "./openai-codex/runtime.js"
import { withPromptImageFit } from "./prompt-image-fit.js"
import type { OpenAiCredentialSnapshot, OpenAiCredentialSource } from "./openai-responses/index.js"

export interface BrokerCredential {
  readonly accessToken: string
  readonly accountId?: string
}

interface BrokeredCredentials {
  /**
   * The credential the host is still fetching; null when nobody is signed in.
   * The provider waits for it on first use, so the server can open without it.
   */
  readonly initial: Promise<BrokerCredential | null>
  readonly request: (forceRefresh: boolean, signal: AbortSignal) => Promise<BrokerCredential | null>
}

/**
 * The host's part of the model route (`ModelProviderSwitch` adds a saved
 * model server's). Every field is optional, as the server reads them: the
 * Codex route happens to supply them all.
 */
export interface ProviderRoute {
  readonly id: "codex"
  readonly start: (credentials: BrokeredCredentials, appVersion: string) => ModelProviderOptions
}

interface ProviderRuntime {
  readonly modelHost: ModelHost
  readonly provider: ModelProvider
  readonly refreshModelHost: () => Promise<ModelHost>
  readonly approvalReview: ApprovalReviewSource
  readonly planLimits: PlanLimitsSource
  readonly transcription: TranscriptionSource
}

const startLazyProvider = (
  discover: () => Promise<ProviderRuntime>
): Omit<ModelProviderOptions, "structuredOutputDialect"> => {
  let failed = false
  let started: ProviderRuntime | undefined
  const readingListeners = new Set<() => void>()
  const attempt = async (): Promise<ProviderRuntime> => {
    failed = false
    try {
      started = await discover()
      started.planLimits.onReading(() => {
        for (const listener of readingListeners) listener()
      })
      return started
    } catch (error) {
      failed = true
      throw error
    }
  }
  let ready = attempt()
  const fitted = new WeakMap<ModelProvider, ModelProvider>()
  const sending = async (): Promise<ModelProvider> => {
    const provider = (await ready).provider
    const known = fitted.get(provider)
    if (known !== undefined) return known
    const fitting = withPromptImageFit(provider, (images, model) =>
      Effect.runFork(
        Effect.logWarning("Fitted stored images to the model's image limit", { model, images })
      )
    )
    fitted.set(provider, fitting)
    return fitting
  }
  const modelHost = ready.then((runtime) => runtime.modelHost)
  void modelHost.catch(() => undefined)
  return {
    modelHost,
    approvalReview: {
      modelId: "openai-codex/codex-auto-review",
      complete: async (input) => (await ready).approvalReview.complete(input)
    },
    planLimits: {
      latest: () => started?.planLimits.latest(),
      history: () => started?.planLimits.history() ?? [],
      refresh: async (signal) => (await ready).planLimits.refresh(signal),
      onReading: (listener) => {
        readingListeners.add(listener)
        return () => readingListeners.delete(listener)
      }
    },
    transcription: {
      transcribe: async (audio, signal) => (await ready).transcription.transcribe(audio, signal)
    },
    refreshModelHost: async () => {
      if (failed) {
        ready = attempt()
        return (await ready).modelHost
      }
      return (await ready).refreshModelHost()
    },
    provider: {
      protocolVersion: MODEL_PROVIDER_PROTOCOL,
      capabilities: async (model) =>
        resolveModelCapabilities({ provider: (await ready).provider, model }),
      openSession: async () => {
        const provider = await sending()
        return (
          (await provider.openSession?.()) ?? { stream: provider.stream, close: () => undefined }
        )
      },
      async *stream(request) {
        const provider = await sending()
        yield* await provider.stream(request)
      }
    }
  }
}

const codexCredential = (credential: BrokerCredential): OpenAiCredentialSnapshot => ({
  accessToken: credential.accessToken,
  ...(credential.accountId === undefined
    ? {}
    : { headers: { "chatgpt-account-id": credential.accountId } })
})

const openAiCodexRoute: ProviderRoute = {
  id: "codex",
  start: (credentials, appVersion) => {
    const source: OpenAiCredentialSource = {
      get: async ({ signal, forceRefresh }) => {
        const credential = await credentials.request(forceRefresh ?? false, signal)
        if (credential === null) throw new Error("OpenAI Codex is not connected")
        return codexCredential(credential)
      }
    }
    const starting = startLazyProvider(async () => {
      const initial = await credentials.initial
      if (initial === null) throw new Error("OpenAI Codex is not connected")
      const runtime = await makeOpenAiCodexRuntime({
        credentials: source,
        initialCredential: codexCredential(initial),
        appVersion
      })
      if (!runtime) throw new Error("OpenAI Codex is not connected")
      return runtime
    })
    // Codex serves the Responses API, so its native structured output is OpenAI strict.
    return { ...starting, structuredOutputDialect: "openai" }
  }
}

export const brokeredProviderRoute: ProviderRoute = openAiCodexRoute

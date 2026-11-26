import { after, type Timer } from "@arden-hq/std/timer"
import { randomUUID } from "node:crypto"

export interface ParentPortSender {
  readonly postMessage: (message: unknown) => void
}

export const PARENT_PORT_RESPONSE = { value: "value", error: "error", invalid: "invalid" } as const

export type ParentPortResponse<T, E> =
  | {
      readonly kind: typeof PARENT_PORT_RESPONSE.value
      readonly requestId: string
      readonly value: T
    }
  | {
      readonly kind: typeof PARENT_PORT_RESPONSE.error
      readonly requestId: string
      readonly error: E
    }
  | { readonly kind: typeof PARENT_PORT_RESPONSE.invalid; readonly requestId: string }

export const PARENT_PORT_FAILURE = {
  aborted: "aborted",
  timeout: "timeout",
  stopped: "stopped",
  dispatch_failed: "dispatch_failed",
  invalid_response: "invalid_response",
  rejected: "rejected"
} as const

export type ParentPortFailure<E> =
  | {
      readonly kind: typeof PARENT_PORT_FAILURE.aborted
      readonly dispatched: boolean
      readonly reason: unknown
    }
  | { readonly kind: typeof PARENT_PORT_FAILURE.timeout }
  | { readonly kind: typeof PARENT_PORT_FAILURE.stopped }
  | { readonly kind: typeof PARENT_PORT_FAILURE.dispatch_failed; readonly cause: unknown }
  | { readonly kind: typeof PARENT_PORT_FAILURE.invalid_response }
  | { readonly kind: typeof PARENT_PORT_FAILURE.rejected; readonly error: E }

export interface ParentPortRpcOptions<T, E> {
  readonly type: string
  readonly timeoutMs: number
  readonly decode: (input: unknown) => ParentPortResponse<T, E> | undefined
  readonly cancelMessage?: string
}

interface ParentPortCall<E> {
  readonly signal?: AbortSignal
  readonly fail: (failure: ParentPortFailure<E>) => unknown
}

export interface ParentPortRpc<T, E> {
  readonly request: (
    payload: Readonly<Record<string, unknown>>,
    call: ParentPortCall<E>
  ) => Promise<T>
  readonly handleMessage: (input: unknown) => boolean
  readonly abortAll: () => void
}

interface Pending<T, E> {
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
  readonly fail: (failure: ParentPortFailure<E>) => unknown
  readonly timer: Timer
  readonly detach: () => void
}

export const createParentPortRpc = <T, E>(
  port: ParentPortSender,
  options: ParentPortRpcOptions<T, E>
): ParentPortRpc<T, E> => {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError(`The ${options.type} timeout must be positive`)
  }
  const pending = new Map<string, Pending<T, E>>()

  const take = (requestId: string): Pending<T, E> | undefined => {
    const request = pending.get(requestId)
    if (request === undefined) return undefined
    pending.delete(requestId)
    request.timer.cancel()
    request.detach()
    return request
  }

  const fail = (requestId: string, failure: ParentPortFailure<E>): void => {
    const request = take(requestId)
    if (request !== undefined) request.reject(request.fail(failure))
  }

  const cancel = (requestId: string, failure: ParentPortFailure<E>): void => {
    if (!pending.has(requestId)) return
    if (options.cancelMessage !== undefined) {
      try {
        port.postMessage({ type: options.cancelMessage, requestId })
      } catch {}
    }
    fail(requestId, failure)
  }

  const request = (
    payload: Readonly<Record<string, unknown>>,
    call: ParentPortCall<E>
  ): Promise<T> => {
    const { signal } = call
    if (signal?.aborted === true) {
      return Promise.reject(
        call.fail({ kind: PARENT_PORT_FAILURE.aborted, dispatched: false, reason: signal.reason })
      )
    }
    const requestId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void =>
        cancel(requestId, {
          kind: PARENT_PORT_FAILURE.aborted,
          dispatched: true,
          reason: signal?.reason
        })
      const timer = after(
        options.timeoutMs,
        () => cancel(requestId, { kind: PARENT_PORT_FAILURE.timeout }),
        {
          unref: true
        }
      )
      pending.set(requestId, {
        resolve,
        reject,
        fail: call.fail,
        timer,
        detach: () => signal?.removeEventListener("abort", onAbort)
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        port.postMessage({ type: options.type, requestId, ...payload })
      } catch (cause) {
        fail(requestId, { kind: PARENT_PORT_FAILURE.dispatch_failed, cause })
      }
    })
  }

  const handleMessage = (input: unknown): boolean => {
    const response = options.decode(input)
    if (response === undefined) return false
    switch (response.kind) {
      case PARENT_PORT_RESPONSE.value: {
        take(response.requestId)?.resolve(response.value)
        return true
      }
      case PARENT_PORT_RESPONSE.error:
        fail(response.requestId, { kind: PARENT_PORT_FAILURE.rejected, error: response.error })
        return true
      case PARENT_PORT_RESPONSE.invalid:
        fail(response.requestId, { kind: PARENT_PORT_FAILURE.invalid_response })
        return true
    }
  }

  const abortAll = (): void => {
    for (const requestId of [...pending.keys()])
      cancel(requestId, { kind: PARENT_PORT_FAILURE.stopped })
  }

  return { request, handleMessage, abortAll }
}

import { after } from "@arden-hq/std/timer"
import {
  addDeviceMessage,
  fromB64url,
  pairCode,
  pairTokenHash,
  sign,
  toB64url,
  type ClientHeader,
  type PairRequestHeader
} from "@arden-hq/relay-protocol"
import { randomBytes } from "node:crypto"
import type { PairedDevice } from "../persistence/relay/store.js"
import type { MacIdentity } from "./identity.js"
import type { DeviceRegistry } from "./ports.js"
import { currentMillis } from "../runtime/clock.js"

const PairingLimits = {
  offerTtlMs: 10 * 60_000,
  offerWaitMs: 5_000,
  offerReuseMs: 60_000,
  requestTtlMs: 5 * 60_000
} as const

export interface PairRequest {
  readonly dev: string
  readonly name: string
  readonly edPub: string
  readonly xPub: string
  readonly code: string
}

export interface RelayPairingOptions {
  readonly identity: MacIdentity
  readonly phoneRelayUrl: string
  readonly macName: string
  readonly devices: DeviceRegistry
  readonly send: (header: ClientHeader) => void
  readonly added: (device: PairedDevice) => void
}

export class RelayPairing {
  readonly #options: RelayPairingOptions
  #offer:
    | { readonly token: Uint8Array; readonly expires: number; readonly link: string }
    | undefined
  #offerWaiter: { readonly hash: string; readonly settle: (ok: boolean) => void } | undefined
  #pairRequest: { readonly request: PairRequest; readonly at: number } | undefined

  constructor(options: RelayPairingOptions) {
    this.#options = options
  }

  get request(): PairRequest | undefined {
    if (
      this.#pairRequest !== undefined &&
      currentMillis() - this.#pairRequest.at > PairingLimits.requestTtlMs
    )
      this.#pairRequest = undefined
    return this.#pairRequest?.request
  }

  async offer(): Promise<{ readonly link: string; readonly expires: number }> {
    const live = this.#offer
    if (live !== undefined && live.expires - currentMillis() > PairingLimits.offerReuseMs)
      return { link: live.link, expires: live.expires }
    const token = new Uint8Array(randomBytes(32))
    const expires = currentMillis() + PairingLimits.offerTtlMs
    const hash = pairTokenHash(token)
    this.#offerWaiter?.settle(false)
    const accepted = new Promise<boolean>((resolve) => {
      const timer = after(PairingLimits.offerWaitMs, () => resolve(false))
      this.#offerWaiter = {
        hash,
        settle: (ok) => {
          timer.cancel()
          this.#offerWaiter = undefined
          resolve(ok)
        }
      }
    })
    this.#options.send({ t: "pair_offer", token_hash: hash, expires })
    if (!(await accepted)) throw new Error("The relay did not take the pairing code")
    const { identity } = this.#options
    const params = new URLSearchParams({
      v: "1",
      relay: this.#options.phoneRelayUrl,
      mac: identity.macId,
      name: this.#options.macName,
      ek: toB64url(identity.x.publicKey),
      sk: toB64url(identity.ed.publicKey),
      t: toB64url(token)
    })
    const link = `arden://pair?${params.toString()}`
    this.#offer = { token, expires, link }
    return { link, expires }
  }

  async decide(dev: string, allow: boolean): Promise<boolean> {
    const request = this.request
    if (request === undefined || request.dev !== dev) return false
    this.#pairRequest = undefined
    if (!allow) {
      this.#options.send({ t: "pair_deny", dev })
      return true
    }
    const device = await this.#options.devices.add({
      dev: request.dev,
      name: request.name,
      edPub: request.edPub,
      xPub: request.xPub
    })
    this.#options.added(device)
    const signature = sign(
      addDeviceMessage({ dev, edPublicKey: fromB64url(request.edPub) }),
      this.#options.identity.ed.secretKey
    )
    this.#options.send({
      t: "add_device",
      dev,
      ed_pub: request.edPub,
      name: request.name,
      sig_mac: toB64url(signature)
    })
    return true
  }

  requested(header: PairRequestHeader): void {
    const offer = this.#offer
    if (offer === undefined || offer.expires < currentMillis()) return
    this.#offer = undefined
    this.#pairRequest = {
      at: currentMillis(),
      request: {
        dev: header.dev,
        name: header.name,
        edPub: header.ed_pub,
        xPub: header.x_pub,
        code: pairCode({
          token: offer.token,
          phoneEdPublicKey: fromB64url(header.ed_pub),
          phoneXPublicKey: fromB64url(header.x_pub)
        })
      }
    }
  }

  gone(dev: string): void {
    if (this.#pairRequest?.request.dev === dev) this.#pairRequest = undefined
  }

  offered(tokenHash: string): void {
    if (this.#offerWaiter?.hash === tokenHash) this.#offerWaiter.settle(true)
  }

  refused(): void {
    this.#offerWaiter?.settle(false)
  }
}

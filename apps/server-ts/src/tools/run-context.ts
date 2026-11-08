import { randomBytes } from "node:crypto"
import type { ReviewPlans } from "./review-plans.js"

import type { ChatApprovalMode } from "@arden-hq/protocol/chat"
import type { ServerToolRun } from "../chat/runner-contract.js"
import type { OfferOutcome, PermissionsView, OfferRequest } from "./permission-offer.js"
import type { CodeModeHost, ScriptHost } from "../workflows/runtime/contract.js"
import type { BrowserObservationCheckpoint, BrowserPageView } from "../browser/observation.js"
export type { BrowserPageView } from "../browser/observation.js"

export interface WikiObservationRegistry {
  readonly observeHead: (head: string) => void
  readonly observedHead: () => string | undefined
  readonly observe: (pageId: string, versionId: string) => void
  readonly observed: (pageId: string) => string | undefined
}

const MAX_OBSERVATIONS = 256

export const makeObservationRegistry = (): WikiObservationRegistry => {
  const versions = new Map<string, string>()
  let head: string | undefined
  return {
    observeHead: (value: string): void => {
      head = value
    },
    observedHead: (): string | undefined => head,
    observe: (pageId: string, versionId: string): void => {
      versions.delete(pageId)
      if (versions.size >= MAX_OBSERVATIONS) {
        const oldest = versions.keys().next().value
        if (oldest !== undefined) versions.delete(oldest)
      }
      versions.set(pageId, versionId)
    },
    observed: (pageId: string): string | undefined => versions.get(pageId)
  }
}

type BrowserSnapshotClaim =
  | { readonly kind: "claimed"; readonly revision: number }
  | { readonly kind: "missing" }
  | { readonly kind: "other" }
  | { readonly kind: "leased" }

export interface BrowserObservationRegistry {
  readonly checkpoint: (tabRef: string) => BrowserObservationCheckpoint
  readonly restore: (checkpoint: BrowserObservationCheckpoint) => void
  readonly observe: (
    tabRef: string,
    revision: number,
    targets: Readonly<Record<string, string>>,
    url?: string
  ) => string
  readonly describe: (tabRef: string, nodeRef: string) => string | undefined
  readonly latest: (tabRef: string) =>
    | {
        readonly ref: string
        readonly targets: Readonly<Record<string, string>>
        readonly url?: string | undefined
      }
    | undefined
  readonly consume: (
    tabRef: string,
    snapshotRef: string,
    toolCallId: string
  ) => BrowserSnapshotClaim
  readonly view: (tabRef: string) => BrowserPageView | undefined
  readonly remember: (tabRef: string, view: BrowserPageView | undefined) => void
  readonly forget: (tabRef: string, toolCallId: string) => void
  readonly lease: (tabRef: string, holderToolCallId: string) => (() => void) | undefined
  readonly mayUse: (tabRef: string, toolCallId: string | undefined) => boolean
  readonly carryOver: (
    tabRef: string,
    snapshotRef: string,
    nodeRef: string | undefined
  ) => string | undefined
  readonly opened: (tabRef: string) => void
  readonly openedHere: (tabRef: string) => boolean
}

const MAX_BROWSER_OBSERVATIONS = 64

const sameElement = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  nodeRef: string | undefined
): boolean => {
  if (nodeRef === undefined)
    return JSON.stringify(Object.entries(before)) === JSON.stringify(Object.entries(after))
  const label = before[nodeRef]
  const once = (targets: Readonly<Record<string, string>>) =>
    Object.values(targets).filter((each) => each === label).length === 1
  return label !== undefined && after[nodeRef] === label && once(before) && once(after)
}

const randomSnapshotRef = (): string => `snap-${randomBytes(6).toString("hex")}`

export const makeBrowserObservationRegistry = ({
  newRef = randomSnapshotRef
}: { readonly newRef?: () => string } = {}): BrowserObservationRegistry => {
  const snapshots = new Map<
    string,
    {
      readonly ref: string
      readonly revision: number
      readonly targets: Readonly<Record<string, string>>
      readonly url?: string | undefined
      readonly carried?: ReadonlySet<string>
    }
  >()
  const spent = new Map<
    string,
    {
      readonly ref: string
      readonly targets: Readonly<Record<string, string>>
      readonly url?: string | undefined
      readonly carried?: ReadonlySet<string>
    }
  >()
  const views = new Map<string, BrowserPageView>()
  const leases = new Map<string, string>()
  const openedTabs = new Map<string, true>()
  const mayUse = (tabRef: string, toolCallId: string | undefined): boolean => {
    const holder = leases.get(tabRef)
    return (
      holder === undefined ||
      (toolCallId !== undefined && (toolCallId === holder || toolCallId.startsWith(`${holder}:`)))
    )
  }
  const bounded = <V>(map: Map<string, V>, tabRef: string, value: V): void => {
    map.delete(tabRef)
    if (map.size >= MAX_BROWSER_OBSERVATIONS) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    map.set(tabRef, value)
  }
  return {
    checkpoint: (tabRef) => {
      const snapshot = snapshots.get(tabRef)
      const view = views.get(tabRef)
      return {
        tabRef,
        snapshot:
          snapshot === undefined
            ? null
            : {
                ref: snapshot.ref,
                revision: snapshot.revision,
                targets: snapshot.targets,
                ...(snapshot.url === undefined ? {} : { url: snapshot.url })
              },
        view:
          view === undefined
            ? null
            : {
                maxChars: view.maxChars,
                ...(view.url === undefined ? {} : { url: view.url }),
                ...(view.scope === undefined ? {} : { scope: view.scope }),
                ...(view.depth === undefined ? {} : { depth: view.depth })
              }
      }
    },
    restore: ({ tabRef, snapshot, view }) => {
      spent.delete(tabRef)
      if (snapshot === null) snapshots.delete(tabRef)
      else bounded(snapshots, tabRef, snapshot)
      if (view === null) views.delete(tabRef)
      else bounded(views, tabRef, view)
    },
    observe: (tabRef, revision, targets, url): string => {
      const ref = newRef()
      bounded(snapshots, tabRef, { ref, revision, targets, url })
      return ref
    },
    describe: (tabRef, nodeRef) => snapshots.get(tabRef)?.targets[nodeRef],
    latest: (tabRef) => {
      const latest = snapshots.get(tabRef)
      return latest === undefined
        ? undefined
        : { ref: latest.ref, targets: latest.targets, url: latest.url }
    },
    consume: (tabRef, snapshotRef, toolCallId): BrowserSnapshotClaim => {
      if (!mayUse(tabRef, toolCallId)) return { kind: "leased" }
      const latest = snapshots.get(tabRef)
      if (latest === undefined) return { kind: "missing" }
      if (latest.ref !== snapshotRef) return { kind: "other" }
      snapshots.delete(tabRef)
      bounded(spent, tabRef, latest)
      return { kind: "claimed", revision: latest.revision }
    },
    view: (tabRef) => views.get(tabRef),
    remember: (tabRef, view): void => {
      if (view === undefined) views.delete(tabRef)
      else bounded(views, tabRef, view)
    },
    lease: (tabRef, holder) => {
      if (!mayUse(tabRef, holder)) return undefined
      leases.set(tabRef, holder)
      return () => {
        if (leases.get(tabRef) === holder) leases.delete(tabRef)
      }
    },
    mayUse,
    carryOver: (tabRef, snapshotRef, nodeRef) => {
      const before = spent.get(tabRef)
      const latest = snapshots.get(tabRef)
      if (before === undefined || latest === undefined) return undefined
      if (before.ref !== snapshotRef && before.carried?.has(snapshotRef) !== true) return undefined
      if (before.url === undefined || before.url !== latest.url) return undefined
      if (!sameElement(before.targets, latest.targets, nodeRef)) return undefined
      bounded(snapshots, tabRef, {
        ...latest,
        carried: new Set([...(before.carried ?? []), before.ref, snapshotRef])
      })
      return latest.ref
    },
    forget: (tabRef, toolCallId): void => {
      if (mayUse(tabRef, toolCallId)) snapshots.delete(tabRef)
    },
    opened: (tabRef): void => bounded(openedTabs, tabRef, true),
    openedHere: (tabRef) => openedTabs.has(tabRef)
  }
}

export interface ServerRunContext extends ServerToolRun {
  readonly approvalMode: ChatApprovalMode
  readonly observations: WikiObservationRegistry
  readonly browserObservations: BrowserObservationRegistry
  readonly mayUseBrowserTab: (tabRef: string, toolCallId: string | undefined) => Promise<boolean>
  readonly reviewPlans: ReviewPlans
  readonly codeMode: CodeModeHost
  readonly scriptHost: ScriptHost
  readonly scriptHostFor: (run: ServerToolRun) => ScriptHost
  readonly offerPermission: (input: {
    readonly toolCallId: string
    readonly request: OfferRequest
  }) => Promise<OfferOutcome>
  readonly readPermissions: () => Promise<PermissionsView>
}

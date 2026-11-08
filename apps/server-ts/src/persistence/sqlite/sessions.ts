import { recordedHistoryReader } from "./recorded-history.js"
import { SessionStore } from "../sessions/store.js"
import type { PersistenceDeps } from "./deps.js"
import { makeEnsureSpaceConversation } from "./space-conversation.js"
import { makeSessionArchive } from "./session-archive.js"
import { makeSessionBranch } from "./session-branch.js"
import { makeSessionContext } from "./session-context.js"
import { makeSessionContinue } from "./session-continue.js"
import { makeSessionLifecycle } from "./session-lifecycle.js"
import { makeSessionListing } from "./session-listing.js"
import { makeSessionCaptureRecords } from "./session-capture.js"
import { makeSessionTriageRecords } from "./session-triage.js"

export const makeSessionStore = (
  deps: Pick<PersistenceDeps, "writer" | "chatEvents" | "sessionEvents" | "reader">
): SessionStore["Service"] =>
  SessionStore.of({
    history: recordedHistoryReader(deps, "session"),
    ensureSpaceConversation: makeEnsureSpaceConversation(deps),
    ...makeSessionListing(deps),
    ...makeSessionLifecycle(deps),
    ...makeSessionBranch(deps),
    ...makeSessionArchive(deps),
    ...makeSessionContinue(deps),
    ...makeSessionContext(deps),
    ...makeSessionTriageRecords(deps),
    ...makeSessionCaptureRecords(deps)
  })

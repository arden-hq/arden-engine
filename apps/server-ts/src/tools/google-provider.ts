import { Effect } from "effect"
import { GoogleConnections } from "../google/service.js"
import { RunQueries } from "../persistence/runs/queries.js"
import { DriveUploadStore } from "../persistence/drive-uploads/store.js"
import { makeGoogleAccountListTool } from "./google-account-list.js"
import type { GoogleToolConnections } from "./google-accounts.js"
import { makeCalendarTools } from "./google-calendar.js"
import { makeDriveTools } from "./google-drive.js"
import { makeDriveFileTools } from "./google-drive-files.js"
import { createSharedFileAccess, sharedFileServices } from "./shared-files.js"
import { makeGmailTools } from "./google-gmail.js"
import type { ToolProvider } from "./provider.js"
import { bindRunGoogleAccounts } from "./run-google-accounts.js"

export const googleToolProvider = Effect.gen(function* () {
  const google = yield* GoogleConnections
  const runs = yield* RunQueries
  const paths = yield* sharedFileServices
  const files = createSharedFileAccess(paths)
  const uploads = yield* DriveUploadStore
  const tools = (accounts: GoogleToolConnections) => [
    makeGoogleAccountListTool({ google, runs }),
    ...makeGmailTools({ google: accounts, paths, files }),
    ...makeCalendarTools({ google: accounts }),
    ...makeDriveTools({ google: accounts }),
    ...makeDriveFileTools({ google: accounts, files, uploads })
  ]
  const provider: ToolProvider = {
    catalog: () => tools(google),
    forRun: (run) =>
      tools(
        bindRunGoogleAccounts({
          google,
          runs,
          runId: run.runId,
          grants: run.policy.google_accounts
        })
      )
  }
  return provider
})

import { Effect } from "effect"
import {
  DriveUploadStore,
  DriveUploadStoreError,
  type DriveUploadKey,
  type DriveUploadReservation
} from "../drive-uploads/store.js"
import type { PersistenceDeps } from "./deps.js"

interface Row {
  readonly session_id: string
  readonly account_ref: string
  readonly operation_key: string
  readonly remote_file_id: string
  readonly request_hash: string
  readonly intent_hash: string
  readonly snapshot_json: string
  readonly status: "reserved" | "confirmed"
}

const reservation = (row: Row): DriveUploadReservation => ({
  sessionId: row.session_id,
  account: row.account_ref,
  operationKey: row.operation_key,
  remoteFileId: row.remote_file_id,
  requestHash: row.request_hash,
  intentHash: row.intent_hash,
  snapshotJson: row.snapshot_json,
  status: row.status
})

export const makeDriveUploadStore = ({
  writer
}: Pick<PersistenceDeps, "writer">): DriveUploadStore["Service"] => {
  const failure = (cause: unknown) =>
    new DriveUploadStoreError({
      message: "The Drive upload record could not be read or saved.",
      cause
    })
  const get: DriveUploadStore["Service"]["get"] = (key) =>
    writer.reader<Row>`
    SELECT * FROM drive_uploads WHERE session_id=${key.sessionId} AND account_ref=${key.account} AND operation_key=${key.operationKey}
  `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : reservation(rows[0]))),
      Effect.mapError(failure)
    )
  const reserve: DriveUploadStore["Service"]["reserve"] = (input) =>
    writer
      .transact(
        Effect.gen(function* () {
          yield* writer.sql`INSERT INTO drive_uploads
        (session_id,account_ref,operation_key,remote_file_id,request_hash,intent_hash,snapshot_json,status)
        VALUES (${input.sessionId},${input.account},${input.operationKey},${input.remoteFileId},${input.requestHash},${input.intentHash},${input.snapshotJson},'reserved')
        ON CONFLICT(session_id,account_ref,operation_key) DO NOTHING`
          const rows =
            yield* writer.sql<Row>`SELECT * FROM drive_uploads WHERE session_id=${input.sessionId} AND account_ref=${input.account} AND operation_key=${input.operationKey}`
          const row = rows[0]
          if (row === undefined)
            return yield* new DriveUploadStoreError({
              message: "The Drive upload could not be reserved."
            })
          return reservation(row)
        })
      )
      .pipe(Effect.mapError(failure))
  const confirm = (key: DriveUploadKey) =>
    writer
      .run(writer.sql`
    UPDATE drive_uploads SET status='confirmed' WHERE session_id=${key.sessionId} AND account_ref=${key.account} AND operation_key=${key.operationKey}
  `)
      .pipe(Effect.asVoid, Effect.mapError(failure))
  return DriveUploadStore.of({ get, reserve, confirm })
}

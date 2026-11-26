import { Context, Effect, Schema } from "effect"

export interface DriveUploadKey {
  readonly sessionId: string
  readonly account: string
  readonly operationKey: string
}

export const DRIVE_UPLOAD_STATUS = { reserved: "reserved", confirmed: "confirmed" } as const

export interface DriveUploadReservation extends DriveUploadKey {
  readonly remoteFileId: string
  readonly requestHash: string
  readonly intentHash: string
  readonly snapshotJson: string
  readonly status: (typeof DRIVE_UPLOAD_STATUS)[keyof typeof DRIVE_UPLOAD_STATUS]
}

export class DriveUploadStoreError extends Schema.TaggedError<DriveUploadStoreError>()(
  "DriveUploadStoreError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) }
) {}

export class DriveUploadStore extends Context.Service<
  DriveUploadStore,
  {
    readonly get: (
      key: DriveUploadKey
    ) => Effect.Effect<DriveUploadReservation | undefined, DriveUploadStoreError>
    readonly reserve: (
      reservation: Omit<DriveUploadReservation, "status">
    ) => Effect.Effect<DriveUploadReservation, DriveUploadStoreError>
    readonly confirm: (key: DriveUploadKey) => Effect.Effect<void, DriveUploadStoreError>
  }
>()("@arden-hq/server/persistence/DriveUploadStore") {}

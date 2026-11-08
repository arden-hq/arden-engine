import type { Migration } from "./index.js"
import { driveUploadsSchemaSection } from "../schema/sections/drive-uploads.js"

export const driveUploads: Migration = {
  version: 123,
  name: "drive_uploads",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of driveUploadsSchemaSection.statements) database.exec(statement)
  }
}

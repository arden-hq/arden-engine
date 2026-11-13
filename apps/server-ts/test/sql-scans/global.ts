import { writeFileSync } from "node:fs"
import { APPROVED_SCANS } from "./approved.js"
import { collectTableScans } from "./collect.js"

/**
 * Runs after the whole test run. Every statement the tests executed was
 * planned by its SQLite thread (ARDEN_SQL_SCAN_LOG); this fails the run when
 * one of them reads a growing table from start to end and is not approved.
 */
export default function setup(): () => void {
  return () => {
    const directory = process.env.ARDEN_SQL_SCAN_LOG
    if (directory === undefined) return
    const approved = new Set(APPROVED_SCANS.map((scan) => `${scan.id}:${scan.table}`))
    const scans = collectTableScans(directory)
    const report = process.env.ARDEN_SQL_SCAN_REPORT
    if (report !== undefined) writeFileSync(report, JSON.stringify(scans, null, 2))
    const fresh = scans.filter((scan) => !approved.has(`${scan.id}:${scan.table}`))
    if (fresh.length === 0) return
    const lines = fresh.map(
      (scan) => `  ${scan.id}  ${scan.table}: ${scan.detail}\n      ${scan.sql.slice(0, 300)}`
    )
    process.exitCode = 1
    throw new Error(
      [
        `${fresh.length} statement(s) read a growing table from start to end.`,
        "Start each from a key or a short list, or approve it with a reason in test/sql-scans/approved.ts.",
        ...lines
      ].join("\n")
    )
  }
}

#!/usr/bin/env node

import { fstatSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"

import { runCli } from "./cli.js"
import { type CliDependencies, type StdinKind } from "./command.js"
import { errorMessage } from "@arden-hq/std/errors"

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

const stdinKind = (): StdinKind => {
  if (process.stdin.isTTY === true) return "terminal"
  try {
    const stats = fstatSync(0)
    if (stats.isFIFO()) return "pipe"
    if (stats.isFile()) return "file"
  } catch {}
  return "other"
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM"
  }
}

const dependencies: CliDependencies = {
  env: process.env,
  homeDirectory: homedir(),
  stdin: stdinKind(),
  readStdin,
  readFile: (path) => readFile(path),
  isProcessAlive,
  writeStdout: (value) => {
    process.stdout.write(value)
  },
  writeStderr: (value) => {
    process.stderr.write(value)
  },
  onSigint: (listener) => {
    process.once("SIGINT", listener)
    return () => process.removeListener("SIGINT", listener)
  }
}

try {
  process.exitCode = await runCli(process.argv.slice(2), dependencies)
} catch (cause) {
  process.stderr.write(`arden: ${errorMessage(cause)}\n`)
  process.exitCode = 1
}

import type { DownloadFile } from "../lib/download.js"

export const CUA_RELEASE = {
  version: "0.36.0",
  directory: "cua-driver-rs-0.36.0-darwin-universal",
  expandedBytes: 232_778_541,
  artifact: {
    path: "cua-driver-rs-0.36.0-darwin-universal.tar.gz",
    url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.36.0/cua-driver-rs-0.36.0-darwin-universal.tar.gz",
    bytes: 83_308_248,
    sha256: "2a83cf9c3a2fa7ae27f3fe62e426aeca5acf76511bb14dd64d10ccb2de6aecae"
  } satisfies DownloadFile
} as const

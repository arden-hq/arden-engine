import { Schema } from "effect"
import { parentPort, workerData } from "node:worker_threads"
import { fitPng } from "../lib/prompt-image.js"
import { PromptImageRequest } from "./prompt-image-worker-protocol.js"

const request = Schema.decodeUnknownSync(PromptImageRequest)(workerData)
const result = fitPng({ bytes: Buffer.from(request.data, "base64"), limits: request.limits })
parentPort?.postMessage(
  result === undefined
    ? undefined
    : {
        data: result.data.toString("base64"),
        size: result.size
      }
)

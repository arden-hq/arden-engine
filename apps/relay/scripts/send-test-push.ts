import { parseArgs } from "node:util"
import { utf8 } from "@arden-hq/relay-protocol"
import { http2Transport, pusherFromEnv } from "../src/bun/apns.js"

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    env: { type: "string", default: "sandbox" },
    topic: { type: "string", default: "com.arden.ios" }
  }
})

const token = values.token
const env = values.env
if (token === undefined || !/^[0-9a-fA-F]{64,200}$/.test(token)) {
  console.error("usage: send-test-push.ts --token <hex> [--env sandbox|production] [--topic id]")
  process.exit(2)
}
if (env !== "sandbox" && env !== "production") {
  console.error("--env is sandbox or production")
  process.exit(2)
}

const apns = http2Transport()
const { pusher, configured } = pusherFromEnv(process.env, apns.transport)
if (!configured) {
  console.error("APNs is not configured: set ARDEN_APNS_KEY_PATH, _KEY_ID and _TEAM_ID")
  process.exit(2)
}
const payload = { aps: { alert: { title: "Arden", body: "Arden test" }, sound: "default" } }
const result = await pusher.push({
  mac: "send-test-push",
  dev: "send-test-push",
  token,
  env,
  topic: values.topic,
  collapseId: "arden-test",
  priority: "high",
  body: utf8(JSON.stringify(payload))
})
apns.close()
console.log(result)
process.exit(result.status === "accepted" ? 0 : 1)

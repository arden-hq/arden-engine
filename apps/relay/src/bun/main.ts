import { parseArgs } from "node:util"
import { http2Transport, pusherFromEnv } from "./apns.js"
import { startRelay } from "./server.js"

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    db: { type: "string", default: "relay.db" }
  }
})

const apns = http2Transport()
const { pusher, configured } = pusherFromEnv(process.env, apns.transport)
const relay = startRelay({
  port: Number(values.port),
  hostname: values.host,
  dbPath: values.db,
  pusher
})
console.log(
  `arden relay listening on ${relay.url}/v1/connect (db ${values.db}, push ${configured ? "on" : "off"})`
)

const shutdown = () => {
  apns.close()
  void relay.stop().then(() => process.exit(0))
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

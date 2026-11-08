import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { spawn } from "node:child_process"
import { writeFileSync, writeSync } from "node:fs"

const stderrBytes = Number(process.env.ARDEN_MCP_FIXTURE_STDERR_BYTES ?? 0)
if (Number.isSafeInteger(stderrBytes) && stderrBytes > 0) {
  writeSync(2, Buffer.alloc(stderrBytes, "x"))
}

const childPidFile = process.env.ARDEN_MCP_FIXTURE_CHILD_PID_FILE
if (childPidFile !== undefined) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 60_000)"], {
    stdio: "ignore"
  })
  if (child.pid === undefined) throw new Error("fixture grandchild did not start")
  writeFileSync(childPidFile, String(child.pid), "utf8")
}

const server = new Server(
  { name: "arden-test-mcp", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
)

let sentRefresh = false
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (sentRefresh && process.env.ARDEN_MCP_FIXTURE_FAIL_REFRESH === "1") {
    throw new Error("fixture refresh failed")
  }
  if (request.params?.cursor === "page-2") {
    if (process.env.ARDEN_MCP_FIXTURE_FAIL_REFRESH === "1") {
      sentRefresh = true
      setTimeout(() => void server.sendToolListChanged(), 100)
    }
    return {
      tools: [
        {
          name: "status",
          description: "Read fixture status",
          inputSchema: { type: "object", properties: {}, additionalProperties: false }
        }
      ]
    }
  }
  return {
    tools: [
      {
        name: process.env.ARDEN_MCP_FIXTURE_ECHO_NAME ?? "echo",
        title: "Fixture Echo",
        description: "Echo one text value",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: { echoed: { type: "string" } },
          required: ["echoed"],
          additionalProperties: false
        }
      }
    ],
    nextCursor: "page-2"
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "status") {
    return { content: [{ type: "text", text: "ready" }] }
  }
  const text = request.params.arguments?.text
  if (typeof text !== "string") {
    return { isError: true, content: [{ type: "text", text: "text is required" }] }
  }
  const environment =
    process.env.ARDEN_MCP_FIXTURE_SECRET === "fixture-secret" ? "present" : "missing"
  return {
    content: [{ type: "text", text: `echo:${text};env:${environment}` }],
    structuredContent: { echoed: text }
  }
})

await server.connect(new StdioServerTransport())

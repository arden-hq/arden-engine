// The slice of the Cloudflare Workers runtime this adapter uses, declared by
// hand: @cloudflare/workers-types redeclares the web globals (Response,
// WebSocket, …) and clashes with bun-types in this one program. Shapes follow
// https://developers.cloudflare.com/durable-objects/api/ (WebSocket
// Hibernation, SQLite storage, alarms).

export interface CfWebSocket {
  send(message: ArrayBuffer | Uint8Array | string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

interface SqlCursor {
  toArray(): Record<string, unknown>[]
}

interface DurableObjectStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: (string | number | ArrayBuffer | Uint8Array | null)[]
    ): SqlCursor
  }
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number): Promise<void>
}

export interface DurableObjectState {
  readonly storage: DurableObjectStorage
  acceptWebSocket(socket: CfWebSocket, tags?: string[]): void
  getWebSockets(tag?: string): CfWebSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  getWebSocketAutoResponseTimestamp(socket: CfWebSocket): Date | null
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}

interface WebSocketRequestResponsePair {
  readonly request: string
  readonly response: string
}

declare global {
  // Workers-only constructors; absent under Bun, used only inside the Durable Object.
  var WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket }
  var WebSocketRequestResponsePair: new (
    request: string,
    response: string
  ) => WebSocketRequestResponsePair
  interface ResponseInit {
    webSocket?: CfWebSocket
  }
}

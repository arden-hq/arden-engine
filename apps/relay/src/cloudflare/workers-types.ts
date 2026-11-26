// Shapes follow https://developers.cloudflare.com/durable-objects/api/

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
  var WebSocketPair: new () => { 0: CfWebSocket; 1: CfWebSocket }
  var WebSocketRequestResponsePair: new (
    request: string,
    response: string
  ) => WebSocketRequestResponsePair
  interface ResponseInit {
    webSocket?: CfWebSocket
  }
}

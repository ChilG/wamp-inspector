export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface FramePayload {
  parsed?: JsonValue;
  rawText?: string;
  format?: string;
}

export type DecodedPayload =
  { kind: "json"; value: JsonValue } | { kind: "text"; value: string };

export interface CapturedFrame extends FramePayload {
  socketId: number;
  messageId?: number;
  timestamp?: string;
  direction?: "sent" | "received";
  url?: string;
  mocked?: boolean;
}

export type SocketState =
  "CONNECTING" | "OPEN" | "CLOSING" | "CLOSED" | "UNKNOWN";

export interface SocketSummary {
  id: number;
  frameId: number;
  documentId: string | null;
  tabId: number;
  url: string;
  state: SocketState;
  createdAt: string;
  protocol: string;
  requestedProtocols: string;
  extensions: string;
  eventType: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string;
  mockSourceMessageId?: number | null;
}

export interface SocketDetail extends Omit<SocketSummary, "lastMessageAt"> {
  lastMessageAt?: string;
  documentEnded?: boolean;
  readyState?: number;
  messages: CapturedFrame[];
}

type SocketEvent = Pick<SocketSummary, "id"> &
  Partial<
    Pick<
      SocketSummary,
      | "createdAt"
      | "eventType"
      | "extensions"
      | "mockSourceMessageId"
      | "protocol"
      | "requestedProtocols"
      | "state"
      | "url"
    >
  > & { readyState?: number };

interface MockResponseSource {
  socketId: number;
  callMessageId: number;
  resultMessageId: number;
}

interface MockResponseCapture {
  tabId: number;
  frameId: number;
  documentId: string;
}

export interface ArmMockResponseCommand extends MockResponseSource {
  type: "arm-mock-response";
  /** JSON-encoded optional RESULT arguments and keyword arguments. */
  resultBody?: string;
  persistent?: true;
}

export type CaptureRequest =
  | { type: "get-sockets"; tabId: number }
  | { type: "get-mock-status"; tabId: number }
  | { type: "set-mock-enabled"; tabId: number; token: string; enabled: boolean }
  | { type: "delete-mock"; tabId: number; token: string }
  | {
      type: "get-socket-detail";
      tabId: number;
      socketId: number;
      frameId?: number;
      documentId?: string | null;
    }
  | { type: "clear-messages"; tabId: number }
  | (ArmMockResponseCommand & MockResponseCapture)
  | (MockResponseSource & MockResponseCapture & { type: "get-mock-response" });

export type WorkerMessage =
  | CaptureRequest
  | { type: "get-reload-mock" }
  | {
      type: "mock-reload-readiness";
      token: string;
      ready: boolean;
      revision?: number;
    }
  | { type: "mock-reload-consumed"; token: string }
  | { type: "ws-event"; payload: SocketEvent }
  | { type: "ws-message"; payload: CapturedFrame };

export interface ReloadMockRule {
  token: string;
  endpoint: string;
  procedure: string;
  topic: string | null;
  resultBody: string;
  persistent?: { enabled: boolean; revision: number };
}

export interface PendingMockStatus {
  state: "saved" | "waiting-socket" | "waiting-call" | "disabled";
  /** Present for persistent mocks that can be toggled or deleted in the panel. */
  token?: string;
  endpoint: string;
  procedure: string;
  topic: string | null;
}

export interface CaptureResponses {
  "get-sockets": { sockets: SocketSummary[] };
  "get-mock-status": { mocks: PendingMockStatus[] };
  "set-mock-enabled": { ok: boolean };
  "delete-mock": { ok: boolean };
  "get-socket-detail": { socket: SocketDetail | null };
  "clear-messages": { ok: boolean };
  "arm-mock-response": { ok: boolean };
  "get-mock-response": { saved: { resultBody: string | null } | null };
}

export type CapturePortRequest =
  { type: "subscribe"; tabId: number } | { type: "ping" };

export type CaptureUpdate =
  | { type: "capture-ready" }
  | {
      type: "capture-updated";
      connections: boolean;
      allMessages: boolean;
      socketKeys: string[];
    };

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
      | "protocol"
      | "requestedProtocols"
      | "state"
      | "url"
    >
  > & { readyState?: number };

export type CaptureRequest =
  | { type: "get-sockets"; tabId: number }
  | {
      type: "get-socket-detail";
      tabId: number;
      socketId: number;
      frameId?: number;
      documentId?: string | null;
    }
  | { type: "clear-messages"; tabId: number };

export type WorkerMessage =
  | CaptureRequest
  | { type: "ws-event"; payload: SocketEvent }
  | { type: "ws-message"; payload: CapturedFrame };

export interface CaptureResponses {
  "get-sockets": { sockets: SocketSummary[] };
  "get-socket-detail": { socket: SocketDetail | null };
  "clear-messages": { ok: boolean };
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

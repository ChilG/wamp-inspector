import { endianness } from "node:os";
import { isMetadataId, isMetadataUri } from "../../src/shared/wamp-metadata.js";

export const nativeHostName = "com.wamp_inspector.bridge";
export const listMethod = "list_wamp_connections";
export const inspectMethod = "inspect_wamp_messages";
export const maxResponseBytes = 256 * 1024;
export const maxRequestBytes = 4 * 1024;
export const maxConnectionIdLength = 64;
export const maxTypeLength = 32;
export const maxUriLength = 256;
export const maxRequestIdLength = 16;
export const maxMessageLimit = 200;
export const messageStatuses = ["pending", "success", "error", "observed"];
export const requestIdPattern = /^\d+$/;

const lengthBytes = 4;
const littleEndian = endianness() === "LE";
const validRequestFields = new Set([
  "connectionId",
  "type",
  "uri",
  "requestId",
  "status",
  "limit",
]);

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function notSharing() {
  return new BridgeError(
    "NOT_SHARING",
    "No Chrome tab is sharing. Open WAMP Inspector and choose Share with MCP.",
  );
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringWithin(value, maximum) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

export function validRequest(method, params) {
  if (!isRecord(params)) return false;
  if (method === listMethod) return Object.keys(params).length === 0;
  if (method !== inspectMethod) return false;
  if (Object.keys(params).some((key) => !validRequestFields.has(key)))
    return false;
  const { connectionId, type, uri, requestId, status, limit } = params;
  return (
    stringWithin(connectionId, maxConnectionIdLength) &&
    (type === undefined ||
      (stringWithin(type, maxTypeLength) && /^[A-Z][A-Z_]*$/.test(type))) &&
    (uri === undefined || isMetadataUri(uri)) &&
    (requestId === undefined || isMetadataId(requestId)) &&
    (status === undefined || messageStatuses.includes(status)) &&
    (limit === undefined ||
      (Number.isInteger(limit) && limit >= 1 && limit <= maxMessageLimit))
  );
}

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > maxResponseBytes)
    throw new Error("Native message is too large.");
  const header = Buffer.alloc(lengthBytes);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export async function* decodeNativeMessages(stream) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of stream) {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= lengthBytes) {
      const length = littleEndian ? bytes.readUInt32LE() : bytes.readUInt32BE();
      if (length > maxResponseBytes || length === 0) {
        throw new Error("Invalid native message length.");
      }
      const end = lengthBytes + length;
      if (bytes.length < end) break;
      yield JSON.parse(bytes.toString("utf8", lengthBytes, end));
      bytes = bytes.subarray(end);
    }
  }
  if (bytes.length > 0) throw new Error("Incomplete native message.");
}

export async function readSocketMessage(socket, maximumBytes) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(0x0a);
    if (
      bytes.length > maximumBytes ||
      (newline !== -1 && newline !== bytes.length - 1)
    ) {
      throw new Error("Invalid bridge message length.");
    }
    if (newline !== -1) return JSON.parse(bytes.toString("utf8", 0, newline));
  }
  throw notSharing();
}

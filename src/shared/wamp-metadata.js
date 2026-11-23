import { readWampFrame } from "./wamp-frame.js";

/** @typedef {import("./capture-contracts.js").CapturedFrame} CapturedFrame */
/** @typedef {"sent" | "received"} Direction */
/** @typedef {"pending" | "success" | "error" | "observed"} Status */
/** @typedef {number | string} ProtocolId */
/** @typedef {{type?: string, uri?: string, requestId?: ProtocolId, status?: Status, limit?: number}} MessageFilters */
/** @typedef {{
 * type: string,
 * direction: Direction,
 * requestId: ProtocolId | null,
 * procedure: string | null,
 * topic: string | null,
 * errorUri: string | null,
 * subscriptionId: ProtocolId | null,
 * publicationId: ProtocolId | null,
 * registrationId: ProtocolId | null,
 * sessionId: ProtocolId | null,
 * timestamp: string | null,
 * status: Status,
 * responseType: string | null,
 * responseTimestamp: string | null,
 * latencyMs: number | null,
 * }} MessageMetadata */

const requestTypes = new Set([16, 32, 34, 48, 64, 66, 68]);
const requestsByResponse = new Map([
  [17, 16],
  [33, 32],
  [35, 34],
  [50, 48],
  [65, 64],
  [67, 66],
  [70, 68],
]);
const requestIdTypes = new Set([
  ...requestTypes,
  ...requestsByResponse.keys(),
  8,
  49,
  69,
]);

export const maxMessageLimit = 200;
const defaultMessageLimit = 50;

/** @param {unknown} value @returns {value is string} */
export function isMetadataUri(value) {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^[a-z0-9_.-]+$/i.test(value)
  );
}

/** @param {unknown} value @returns {value is ProtocolId} */
export function isMetadataId(value) {
  return (
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 2 ** 53) ||
    (typeof value === "string" &&
      /^\d{1,16}$/.test(value) &&
      BigInt(value) <= 2n ** 53n)
  );
}

/** @param {unknown} value */
const protocolId = (value) => (isMetadataId(value) ? value : null);
/** @param {unknown} value */
const protocolUri = (value) => (isMetadataUri(value) ? value : null);

/** @param {unknown} value */
function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** @param {unknown} value @param {string} key */
function detail(value, key) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
    ? /** @type {Record<string, unknown>} */ (value)[key]
    : null;
}

/** @param {CapturedFrame} frame @param {Map<string, string>} topics */
function describe(frame, topics) {
  const { payload, knownType, code } = readWampFrame(frame);
  const value = payload.value;
  const { direction } = frame;
  if (
    !knownType ||
    code === null ||
    !Array.isArray(value) ||
    (direction !== "sent" && direction !== "received")
  )
    return null;

  const requestId = requestIdTypes.has(code)
    ? protocolId(value[code === 8 ? 2 : 1])
    : null;
  const requestType =
    code === 8
      ? typeof value[1] === "number" && requestTypes.has(value[1])
        ? value[1]
        : undefined
      : requestsByResponse.get(code);
  const progressive =
    (code === 50 || code === 70) && detail(value[2], "progress") === true;
  const isPendingRequest =
    requestTypes.has(code) &&
    requestId !== null &&
    direction === (code === 68 ? "received" : "sent") &&
    (code !== 16 || detail(value[2], "acknowledge") === true);

  /** @type {Status} */
  let status = "observed";
  if (isPendingRequest) status = "pending";
  else if (code === 8) status = "error";
  else if (requestType !== undefined && !progressive) status = "success";

  const publicationId =
    code === 17 || code === 36 ? protocolId(value[2]) : null;
  const subscriptionId =
    code === 36
      ? protocolId(value[1])
      : code === 33 || code === 34
        ? protocolId(value[2])
        : null;
  const registrationId = [65, 66, 68].includes(code)
    ? protocolId(value[2])
    : null;
  let topic = code === 16 || code === 32 ? protocolUri(value[3]) : null;
  if (code === 36) {
    topic =
      protocolUri(detail(value[3], "topic")) ??
      (subscriptionId === null
        ? null
        : (topics.get(String(subscriptionId)) ?? null));
  }

  /** @type {MessageMetadata} */
  const metadata = {
    type: knownType,
    direction,
    requestId,
    procedure: code === 48 || code === 64 ? protocolUri(value[3]) : null,
    topic,
    errorUri: code === 8 ? protocolUri(value[4]) : null,
    subscriptionId,
    publicationId,
    registrationId,
    sessionId: code === 2 ? protocolId(value[1]) : null,
    timestamp: timestamp(frame.timestamp),
    status,
    responseType: null,
    responseTimestamp: null,
    latencyMs: null,
  };
  return { metadata, code, requestType, progressive };
}

/** @param {MessageMetadata} request @param {MessageMetadata} response @returns {MessageMetadata} */
function pair(request, response) {
  const elapsed =
    request.timestamp && response.timestamp
      ? Date.parse(response.timestamp) - Date.parse(request.timestamp)
      : null;
  return {
    ...request,
    errorUri: response.errorUri,
    publicationId: response.publicationId ?? request.publicationId,
    subscriptionId: response.subscriptionId ?? request.subscriptionId,
    registrationId: response.registrationId ?? request.registrationId,
    status: response.status,
    responseType: response.type,
    responseTimestamp: response.timestamp,
    latencyMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
  };
}

/** @param {CapturedFrame[]} frames */
function summarize(frames) {
  /** @type {Map<string, number>} */
  const pending = new Map();
  /** @type {Map<string, string>} */
  const topics = new Map();
  /** @type {MessageMetadata[]} */
  const messages = [];
  for (const frame of frames) {
    const current = describe(frame, topics);
    if (!current) continue;
    const { metadata, code, requestType, progressive } = current;
    const { requestId, direction } = metadata;
    if (
      requestId !== null &&
      requestType !== undefined &&
      !progressive &&
      direction === (requestType === 68 ? "sent" : "received")
    ) {
      const key = `${requestType}:${requestId}`;
      const index = pending.get(key);
      if (index !== undefined) {
        const exchange = pair(messages[index], metadata);
        messages[index] = exchange;
        pending.delete(key);
        const { subscriptionId, topic } = exchange;
        if (code === 33 && subscriptionId !== null && topic !== null)
          topics.set(String(subscriptionId), topic);
        if (code === 35 && subscriptionId !== null)
          topics.delete(String(subscriptionId));
        continue;
      }
    }
    if (metadata.status === "pending")
      pending.set(`${code}:${requestId}`, messages.length);
    messages.push(metadata);
  }
  return messages;
}

/** @param {CapturedFrame[]} frames @param {MessageFilters} filters */
export function inspectWampMessages(frames, filters) {
  const { type, uri, requestId, status, limit = defaultMessageLimit } = filters;
  const matching = summarize(frames).filter(
    (row) =>
      (type === undefined || row.type === type || row.responseType === type) &&
      (uri === undefined ||
        [row.procedure, row.topic, row.errorUri].includes(uri)) &&
      (requestId === undefined ||
        String(row.requestId) === String(requestId)) &&
      (status === undefined || row.status === status),
  );
  return {
    messages: matching.slice(-limit),
    truncated: matching.length > limit,
  };
}

import { readWampFrame } from "../shared/wamp-frame.js";

const requestTypes = new Set([16, 32, 34, 48, 64, 66]);
const responseRequests = new Map([
  [17, 16],
  [33, 32],
  [35, 34],
  [50, 48],
  [65, 64],
  [67, 66],
]);

function requestId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function readTopic(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function messageTopic(type, data, subscriptions) {
  switch (type) {
    case "CALL":
      return readTopic(data[5]?.topic);
    case "PUBLISH":
    case "SUBSCRIBE":
      return readTopic(data[3]);
    case "EVENT":
      return (
        readTopic(data[3]?.topic) ?? subscriptions.get(String(data[1])) ?? null
      );
    default:
      return null;
  }
}

function describeEvent(data) {
  const details = data[4]?.[0];
  const eventId = requestId(details?.eventId);
  const marketId = requestId(details?.marketId);
  const subject =
    eventId != null
      ? `Event #${eventId}`
      : marketId != null
        ? `Market #${marketId}`
        : "";
  const status = typeof details?.status === "string" ? details.status : "";
  return (
    [subject, status].filter(Boolean).join(" · ") ||
    `Subscription #${data[1] ?? "—"}`
  );
}

function summarizeMessage(type, payload) {
  const data = payload.value;
  switch (type) {
    case "HELLO":
      return typeof data[1] === "string" ? `Realm ${data[1]}` : type;
    case "WELCOME":
      return data[1] == null ? type : `Session #${data[1]}`;
    case "PUBLISH":
    case "SUBSCRIBE":
      return "";
    case "CALL":
    case "REGISTER":
      return typeof data[3] === "string" ? data[3] : type;
    case "ABORT":
    case "GOODBYE":
      return typeof data[2] === "string" ? data[2] : type;
    case "ERROR":
      return typeof data[4] === "string" ? data[4] : type;
    case "SUBSCRIBED":
      return `Subscription #${data[2] ?? "—"}`;
    case "EVENT":
      return describeEvent(data);
    case "RESULT":
      return data[2]?.progress === true ? "Progressive result" : type;
    case "JSON":
      return Array.isArray(data)
        ? `JSON array · ${data.length} items`
        : "JSON payload";
    case "TEXT":
      return (
        data.slice(0, 120).replace(/\s+/g, " ").trim() || "Empty text frame"
      );
    default:
      return type;
  }
}

function frameKey(message, index, occurrences) {
  const base = JSON.stringify([
    message.messageId ?? null,
    message.timestamp ?? null,
    message.direction ?? null,
    message.messageId == null ? index : null,
  ]);
  const occurrence = occurrences.get(base) ?? 0;
  occurrences.set(base, occurrence + 1);
  return `${base}:${occurrence}`;
}

function describeFrame(message, subscriptions, key) {
  const { payload, code, type } = readWampFrame(message);
  const { value } = payload;
  const originalRequest = code === 8 ? value[1] : responseRequests.get(code);
  const id =
    code != null &&
    (requestTypes.has(code) ||
      originalRequest != null ||
      [49, 68, 69, 70].includes(code))
      ? requestId(value[code === 8 ? 2 : 1])
      : null;
  const progressive = code === 50 && value[2]?.progress === true;
  let responseState = "";
  if (code === 8) responseState = "error";
  else if (originalRequest != null && !progressive) responseState = "success";

  return {
    key,
    messageId: message.messageId,
    mocked: message.mocked === true,
    type,
    code,
    id,
    payload,
    originalRequest,
    progressive,
    responseState,
    direction: message.direction === "sent" ? "sent" : "received",
    time: message.timestamp,
    summary: summarizeMessage(type, payload),
    topic: messageTopic(type, value, subscriptions),
  };
}

function pairResponse(request, reply) {
  const elapsed = Date.parse(reply.time) - Date.parse(request.time);
  return {
    ...request,
    response: reply.payload,
    replyKey: reply.key,
    replySummary: reply.summary,
    responseType: reply.type,
    responseMessageId: reply.messageId,
    responseMocked: reply.mocked,
    responseTime: reply.time,
    responseState: reply.responseState,
    latency: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
  };
}

export function analyzeMessages(messages) {
  const pending = new Map();
  const subscriptions = new Map();
  const occurrences = new Map();
  const rows = [];

  messages.forEach((message, index) => {
    const frame = describeFrame(
      message,
      subscriptions,
      frameKey(message, index, occurrences),
    );
    const { id, code } = frame;
    if (
      frame.direction === "received" &&
      frame.originalRequest != null &&
      id != null &&
      !frame.progressive
    ) {
      const key = `${frame.originalRequest}:${id}`;
      const position = pending.get(key);
      if (position !== undefined) {
        const request = rows[position];
        rows[position] = pairResponse(request, frame);
        pending.delete(key);
        if (code === 33 && request.topic !== null)
          subscriptions.set(String(frame.payload.value[2]), request.topic);
        if (code === 35) subscriptions.delete(String(request.payload.value[2]));
        return;
      }
    }

    if (frame.direction === "sent" && requestTypes.has(code) && id != null) {
      pending.set(`${code}:${id}`, rows.length);
      rows.push({ ...frame, direction: "exchange", responseState: "pending" });
    } else {
      rows.push(frame);
    }
  });

  const latencies = rows.flatMap((row) =>
    row.latency == null ? [] : [row.latency],
  );
  const averageLatency = latencies.length
    ? Math.round(
        latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      )
    : null;
  return { rows, pendingCount: pending.size, averageLatency };
}

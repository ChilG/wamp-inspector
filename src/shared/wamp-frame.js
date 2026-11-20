/** @type {Partial<Record<number, string>>} */
const messageTypes = {
  1: "HELLO",
  2: "WELCOME",
  3: "ABORT",
  4: "CHALLENGE",
  5: "AUTHENTICATE",
  6: "GOODBYE",
  8: "ERROR",
  16: "PUBLISH",
  17: "PUBLISHED",
  32: "SUBSCRIBE",
  33: "SUBSCRIBED",
  34: "UNSUBSCRIBE",
  35: "UNSUBSCRIBED",
  36: "EVENT",
  48: "CALL",
  49: "CANCEL",
  50: "RESULT",
  64: "REGISTER",
  65: "REGISTERED",
  66: "UNREGISTER",
  67: "UNREGISTERED",
  68: "INVOCATION",
  69: "INTERRUPT",
  70: "YIELD",
};

/**
 * @param {import("./capture-contracts.js").FramePayload} message
 * @returns {import("./capture-contracts.js").DecodedPayload}
 */
function readPayload(message) {
  if (message.parsed != null) return { kind: "json", value: message.parsed };
  const value = typeof message.rawText === "string" ? message.rawText : "";
  if (!message.format || message.format === "text") {
    try {
      return { kind: "json", value: JSON.parse(value) };
    } catch {
      // Plain text is a valid WebSocket frame.
    }
  }
  return { kind: "text", value };
}

/** @param {import("./capture-contracts.js").FramePayload} message */
export function readWampFrame(message) {
  const payload = readPayload(message);
  const { value } = payload;
  const first = Array.isArray(value) ? value[0] : undefined;
  const code =
    typeof first === "number" && Number.isInteger(first) ? first : null;
  const knownType =
    code === null
      ? payload.kind === "json"
        ? "JSON"
        : "TEXT"
      : (messageTypes[code] ?? null);
  return { payload, code, type: knownType ?? `TYPE_${code}`, knownType };
}

import {
  inspectWampMessages,
  isMetadataId,
  isMetadataUri,
  maxMessageLimit,
} from "../shared/wamp-metadata.js";

/** @typedef {import("../shared/capture-contracts.js").CapturedFrame} CapturedFrame */
/** @typedef {import("../shared/wamp-metadata.js").MessageFilters} MessageFilters */
/** @typedef {import("../shared/wamp-metadata.js").Status} Status */
/** @typedef {{protocol: string, state: string, history: {size: number, toArray: () => CapturedFrame[]}}} Connection */
/** @typedef {"connecting" | "sharing" | "stopped" | "error"} ShareStatus */
/** @typedef {{tabId: number, panel: chrome.runtime.Port, phase: "authorizing" | "connecting" | "ready", timer: ReturnType<typeof setTimeout> | null, aliases: Map<string, string>}} ShareSession */

const handshakeTimeoutMs = 5_000;
const validStatuses = new Set(["pending", "success", "error", "observed"]);
const validStates = new Set(["CONNECTING", "OPEN", "CLOSING", "CLOSED"]);
const queryKeys = new Set([
  "connectionId",
  "type",
  "uri",
  "requestId",
  "status",
  "limit",
]);

class QueryError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} value */
function parseQuery(value) {
  const query = asRecord(value);
  if (!query || Object.keys(query).some((key) => !queryKeys.has(key)))
    throw new QueryError("invalid_request", "Invalid message filters.");

  const { connectionId, type, uri, requestId, status, limit } = query;
  if (
    typeof connectionId !== "string" ||
    !connectionId ||
    connectionId.length > 64
  )
    throw new QueryError("invalid_request", "A connection ID is required.");
  if (
    type !== undefined &&
    (typeof type !== "string" || !/^[A-Z][A-Z_]{0,31}$/.test(type))
  )
    throw new QueryError("invalid_request", "Invalid WAMP message type.");
  if (uri !== undefined && !isMetadataUri(uri))
    throw new QueryError("invalid_request", "Invalid WAMP URI.");
  if (requestId !== undefined && !isMetadataId(requestId))
    throw new QueryError("invalid_request", "Invalid WAMP request ID.");
  if (
    status !== undefined &&
    (typeof status !== "string" || !validStatuses.has(status))
  )
    throw new QueryError("invalid_request", "Invalid WAMP message status.");
  if (
    limit !== undefined &&
    (typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > maxMessageLimit)
  )
    throw new QueryError(
      "invalid_request",
      "Message limit must be between 1 and 200.",
    );

  /** @type {MessageFilters} */
  const filters = {
    type,
    uri,
    requestId,
    status: /** @type {Status | undefined} */ (status),
    limit,
  };
  return { connectionId, filters };
}

/** @param {chrome.runtime.Port} panel @param {ShareStatus} state @param {string} [message] */
function postStatus(panel, state, message) {
  try {
    panel.postMessage({ type: "mcp-share-status", state, message });
  } catch {
    // The panel can close before a pending state change is delivered.
  }
}

/** @param {Connection} connection @param {string} connectionId */
function describeConnection(connection, connectionId) {
  const protocol =
    typeof connection.protocol === "string"
      ? connection.protocol.toLowerCase()
      : "";
  return {
    connectionId,
    protocol:
      /^wamp\.2\.(?:json|msgpack|cbor|ubjson|flatbuffers)(?:\.batched)?$/.test(
        protocol,
      )
        ? protocol
        : "wamp",
    state: validStates.has(connection.state) ? connection.state : "UNKNOWN",
    retainedCount: connection.history.size,
  };
}

/**
 * @param {typeof chrome} chromeApi
 * @param {(tabId: number) => Iterable<[string, Connection]>} getConnections
 */
export function createMcpSharing(chromeApi, getConnections) {
  /** @type {ShareSession | null} */
  let active = null;

  /** @param {ShareSession} session @param {"stopped" | "error"} state @param {string} [message] */
  function stop(session, state, message) {
    if (active !== session) return;
    active = null;
    if (session.timer !== null) clearTimeout(session.timer);
    postStatus(session.panel, state, message);
  }

  /** @param {ShareSession} session @param {Record<string, unknown>} request */
  function readCapture(session, { method, params }) {
    const connections = getConnections(session.tabId);
    if (method === "list_wamp_connections") {
      const query = asRecord(params);
      if (params !== undefined && (!query || Object.keys(query).length))
        throw new QueryError(
          "invalid_request",
          "Connection listing takes no arguments.",
        );
      return {
        connections: Array.from(connections, ([key, connection]) => {
          const connectionId = session.aliases.get(key) ?? crypto.randomUUID();
          session.aliases.set(key, connectionId);
          return describeConnection(connection, connectionId);
        }),
      };
    }
    if (method !== "inspect_wamp_messages")
      throw new QueryError(
        "invalid_request",
        "Unsupported WAMP capture operation.",
      );
    const { connectionId, filters } = parseQuery(params);
    for (const [key, connection] of connections) {
      if (session.aliases.get(key) === connectionId)
        return inspectWampMessages(connection.history.toArray(), filters);
    }
    throw new QueryError(
      "unknown_connection",
      "Connection not found. List shared connections again.",
    );
  }

  /** @param {ShareSession} session @param {unknown} value */
  function handleHostMessage(session, value) {
    const input = asRecord(value);
    if (!input) return;
    if (session.phase === "connecting" && input.type === "error") {
      const { message } = input;
      stop(
        session,
        "error",
        typeof message === "string" &&
          message.length > 0 &&
          message.length <= 256
          ? message
          : "The WAMP companion could not start. Try sharing again.",
      );
      return;
    }
    if (input.type === "ready") {
      if (session.phase !== "connecting") return;
      if (session.timer !== null) clearTimeout(session.timer);
      session.timer = null;
      session.phase = "ready";
      postStatus(session.panel, "sharing");
      return;
    }

    const { id } = input;
    if (
      session.phase !== "ready" ||
      !(
        Number.isSafeInteger(id) ||
        (typeof id === "string" && /^[a-z0-9_-]{1,64}$/i.test(id))
      )
    )
      return;

    let response;
    try {
      response = { id, result: readCapture(session, input) };
    } catch (error) {
      response = {
        id,
        error:
          error instanceof QueryError
            ? { code: error.code, message: error.message }
            : {
                code: "unavailable",
                message: "WAMP capture could not be read.",
              },
      };
    }
    try {
      session.panel.postMessage({ type: "native-response", message: response });
    } catch {
      stop(
        session,
        "error",
        "The WAMP companion disconnected. Try sharing again.",
      );
    }
  }

  /** @param {ShareSession} session */
  async function authorizeTab(session) {
    try {
      await chromeApi.tabs.get(session.tabId);
    } catch {
      stop(session, "error", "The inspected tab is unavailable.");
      return;
    }
    if (active !== session) return;
    session.phase = "connecting";
    session.timer = setTimeout(
      () =>
        stop(
          session,
          "error",
          "The WAMP companion did not respond. Check the installation and try again.",
        ),
      handshakeTimeoutMs,
    );
    postStatus(session.panel, "connecting");
  }

  /** @param {ShareSession} session @param {Record<string, unknown>} request */
  function relay(session, request) {
    if (active !== session || session.phase === "authorizing") return;
    if (request.type === "native-message") {
      handleHostMessage(session, request.message);
    } else if (request.type === "native-disconnected") {
      const message =
        request.hadError === true
          ? "Cannot connect to the WAMP companion. Check the installation and try again."
          : "The WAMP companion disconnected. Try sharing again.";
      stop(session, "error", message);
    }
  }

  /** @param {chrome.runtime.Port} panel */
  function connect(panel) {
    if (
      panel.sender?.id !== chromeApi.runtime.id ||
      panel.sender.url !== chromeApi.runtime.getURL("src/devtools/panel.html")
    )
      return;

    /** @type {ShareSession | null} */
    let owned = null;
    panel.onMessage.addListener((value) => {
      const request = asRecord(value);
      if (!request) return;
      if (owned) {
        relay(owned, request);
        return;
      }
      if (request.type !== "share") return;
      const { tabId } = request;
      if (
        typeof tabId !== "number" ||
        !Number.isSafeInteger(tabId) ||
        tabId < 0
      ) {
        postStatus(panel, "error", "No inspected tab is available to share.");
        return;
      }
      if (active) {
        postStatus(
          panel,
          "error",
          "Another WAMP Inspector tab is already being shared.",
        );
        return;
      }
      owned = {
        tabId,
        panel,
        phase: "authorizing",
        timer: null,
        aliases: new Map(),
      };
      active = owned;
      void authorizeTab(owned);
    });
    panel.onDisconnect.addListener(() => {
      if (owned) stop(owned, "stopped");
    });
  }

  /** @param {number} tabId */
  function revokeTab(tabId) {
    if (active?.tabId === tabId) stop(active, "stopped");
  }

  chromeApi.permissions?.onRemoved.addListener(({ permissions }) => {
    if (active && permissions?.includes("nativeMessaging")) {
      stop(active, "stopped", "Native Messaging permission was removed.");
    }
  });

  return { connect, revokeTab };
}

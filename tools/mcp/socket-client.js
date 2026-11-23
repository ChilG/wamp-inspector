import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import {
  BridgeError,
  isRecord,
  maxResponseBytes,
  notSharing,
  readSocketMessage,
  validRequest,
} from "./protocol.js";
import {
  checkSocketDirectory,
  checkSocketFile,
  getSocketPath,
} from "./socket-path.js";

const noShareCodes = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export async function requestCapture(
  method,
  params,
  { socketPath = getSocketPath(), timeout = 4000 } = {},
) {
  if (!validRequest(method, params)) {
    throw new BridgeError("INVALID_REQUEST", "Invalid WAMP Inspector request.");
  }

  let socket;
  let timer;
  try {
    await checkSocketDirectory(socketPath);
    await checkSocketFile(socketPath);
    socket = createConnection({ path: socketPath });
    timer = setTimeout(() => {
      socket.destroy(
        new BridgeError(
          "BRIDGE_TIMEOUT",
          "The Chrome bridge timed out. Check the WAMP Inspector panel and try again.",
        ),
      );
    }, timeout);

    const id = randomUUID();
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
    const response = await readSocketMessage(socket, maxResponseBytes + 1);
    if (response?.id === id) {
      if (response.error)
        throw new BridgeError(response.error.code, response.error.message);
      if (isRecord(response.result)) return response.result;
    }
    throw new BridgeError(
      "INVALID_RESPONSE",
      "The Chrome bridge returned an invalid response.",
    );
  } catch (error) {
    if (noShareCodes.has(error.code)) throw notSharing();
    throw error;
  } finally {
    clearTimeout(timer);
    socket?.destroy();
  }
}

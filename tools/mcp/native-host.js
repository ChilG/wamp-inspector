import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import {
  decodeNativeMessages,
  encodeNativeMessage,
  isRecord,
  maxRequestBytes,
  readSocketMessage,
  validRequest,
} from "./protocol.js";
import { getSocketPath, listenOnPrivateSocket } from "./socket-path.js";

const extensionOriginPattern = /^chrome-extension:\/\/[a-p]{32}\/?$/;
const requestIdPattern = /^[0-9a-f-]{36}$/;
const socketTimeoutMs = 5000;

function reportError(message) {
  process.stderr.write(`WAMP Inspector: ${message}\n`);
}

function writeNative(message) {
  process.stdout.write(encodeNativeMessage(message));
}

function sendSocketResponse(socket, response) {
  if (socket.writable) socket.end(`${JSON.stringify(response)}\n`);
}

function validResponse(message) {
  return (
    isRecord(message) &&
    typeof message.id === "string" &&
    ((isRecord(message.result) && message.error === undefined) ||
      (message.result === undefined &&
        isRecord(message.error) &&
        typeof message.error.code === "string" &&
        typeof message.error.message === "string"))
  );
}

async function handleSocket(socket, pending, clients) {
  clients.add(socket);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(socketTimeoutMs, () => socket.destroy());
  let requestId;
  socket.once("close", () => {
    clients.delete(socket);
    if (pending.get(requestId) === socket) pending.delete(requestId);
  });
  try {
    const request = await readSocketMessage(socket, maxRequestBytes);
    requestId = request?.id;
    if (
      typeof requestId !== "string" ||
      !requestIdPattern.test(requestId) ||
      pending.has(requestId) ||
      !validRequest(request.method, request.params)
    ) {
      sendSocketResponse(socket, {
        id: requestId ?? null,
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid WAMP Inspector request.",
        },
      });
      return;
    }
    pending.set(requestId, socket);
    writeNative({
      id: requestId,
      method: request.method,
      params: request.params,
    });
  } catch {
    socket.destroy();
  }
}

async function run() {
  if (!extensionOriginPattern.test(process.argv[2] ?? "")) {
    throw new Error(
      "The native host must be launched by Chrome with an extension origin.",
    );
  }
  process.umask(0o077);
  const socketPath = getSocketPath();
  const clients = new Set();
  const pending = new Map();
  const server = createServer(
    (socket) => void handleSocket(socket, pending, clients),
  );
  server.maxConnections = 16;
  const stop = () => process.stdin.destroy();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdout.on("error", stop);

  try {
    await listenOnPrivateSocket(server, socketPath);
    await chmod(socketPath, 0o600);
    writeNative({ type: "ready" });
    for await (const message of decodeNativeMessages(process.stdin)) {
      if (!validResponse(message))
        throw new Error("Invalid response from Chrome.");
      const socket = pending.get(message.id);
      if (!socket) continue;
      pending.delete(message.id);
      const { id, result, error } = message;
      sendSocketResponse(socket, error ? { id, error } : { id, result });
    }
  } catch (error) {
    if (error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
      const message =
        error.code === "SHARING_BUSY" || error.code === "UNSAFE_SOCKET_PATH"
          ? error.message
          : "The local bridge could not be started or was disconnected.";
      writeNative({ type: "error", message });
      reportError(message);
      process.exitCode = 1;
    }
  } finally {
    for (const socket of clients) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

run().catch(() => {
  reportError("The native host could not be started.");
  process.exitCode = 1;
});

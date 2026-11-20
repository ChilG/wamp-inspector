import { sendCaptureRequest } from "../../src/shared/capture-client.js";
import type {
  CapturePortRequest,
  SocketDetail,
  SocketSummary,
} from "../../src/shared/capture-contracts.js";

async function checkCaptureContracts() {
  const { sockets }: { sockets: SocketSummary[] } = await sendCaptureRequest({
    type: "get-sockets",
    tabId: 7,
  });
  const id = sockets[0]?.id ?? 1;
  const { socket }: { socket: SocketDetail | null } = await sendCaptureRequest({
    type: "get-socket-detail",
    tabId: 7,
    socketId: id,
    frameId: 0,
    documentId: null,
  });
  if (socket) {
    const lastMessage = socket.messages.at(-1);
    // @ts-expect-error Decoded JSON must be narrowed before reading an application field.
    lastMessage?.parsed?.topic;
  }

  // @ts-expect-error Socket detail requires a socket ID.
  await sendCaptureRequest({ type: "get-socket-detail", tabId: 7 });
  // @ts-expect-error Only the detail response includes a socket.
  (await sendCaptureRequest({ type: "clear-messages", tabId: 7 })).socket;
  // @ts-expect-error A capture subscription requires a numeric tab ID.
  const subscription: CapturePortRequest = { type: "subscribe", tabId: "7" };
  return subscription;
}

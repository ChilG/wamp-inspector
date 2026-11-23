import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const host = "127.0.0.1";
const subprotocol = "wamp.2.json";
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/demo.js", ["demo.js", "text/javascript"]],
  ["/demo.css", ["demo.css", "text/css"]],
]);

async function loadDemo() {
  return new Map(
    await Promise.all(
      Array.from(assets, async ([path, [name, mimeType]]) => {
        const content = await readFile(new URL(name, import.meta.url));
        return [path, { content, mimeType }];
      }),
    ),
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCall(frame) {
  const [, id, options, procedure, args, kwargs] = frame;
  return (
    frame.length >= 4 &&
    frame.length <= 6 &&
    Number.isSafeInteger(id) &&
    id >= 0 &&
    isObject(options) &&
    typeof procedure === "string" &&
    (frame.length < 5 || Array.isArray(args)) &&
    (frame.length < 6 || isObject(kwargs))
  );
}

function replyToCall(frame, send) {
  const [, id, , procedure] = frame;
  switch (procedure) {
    case "demo.success":
      send([50, id, {}, ["Mock result"]]);
      return;
    case "demo.error":
      send([8, 48, id, {}, "com.example.mock_error"]);
      return;
    case "demo.no_response":
      return;
    default:
      send([8, 48, id, {}, "wamp.error.no_such_procedure"]);
  }
}

function denyUpgrade(socket, status) {
  socket.once("error", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

function handleSession(socket, sessionId) {
  let welcomed = false;
  const send = (frame) => socket.send(JSON.stringify(frame));
  const reject = () => socket.close(1002, "Invalid WAMP message");

  socket.on("error", () => socket.terminate());
  socket.on("message", (data, binary) => {
    if (binary) return reject();

    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return reject();
    }
    if (!Array.isArray(frame)) return reject();

    if (!welcomed) {
      const [type, realm, details] = frame;
      if (
        type !== 1 ||
        frame.length !== 3 ||
        !isObject(details?.roles?.caller)
      ) {
        return reject();
      }
      if (realm !== "demo") {
        send([3, {}, "wamp.error.no_such_realm"]);
        return socket.close(1000);
      }
      welcomed = true;
      send([2, sessionId, { roles: { dealer: {} } }]);
      return;
    }

    if (frame[0] === 48 && isCall(frame)) {
      return replyToCall(frame, send);
    }
    if (
      frame[0] === 6 &&
      frame.length === 3 &&
      isObject(frame[1]) &&
      typeof frame[2] === "string"
    ) {
      send([6, {}, "wamp.close.goodbye_and_out"]);
      return socket.close(1000);
    }
    return reject();
  });
}

export async function startMockRouter({ port = 8765 } = {}) {
  const demo = await loadDemo();
  let authority;
  let origin;
  let nextSessionId = 1;

  const server = createServer((request, response) => {
    const asset = demo.get(request.url);
    if (
      request.headers.host !== authority ||
      !asset ||
      request.method !== "GET"
    ) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "Content-Type": `${asset.mimeType}; charset=utf-8`,
        "Content-Security-Policy": `default-src 'self'; connect-src ws://${authority}; img-src data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        "X-Content-Type-Options": "nosniff",
      })
      .end(asset.content);
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024,
    handleProtocols: (requested) => requested.has(subprotocol) && subprotocol,
  });
  sockets.on("connection", (socket) => handleSession(socket, nextSessionId++));
  server.on("upgrade", (request, socket, head) => {
    if (
      request.headers.host !== authority ||
      request.headers.origin !== origin
    ) {
      denyUpgrade(socket, "403 Forbidden");
      return;
    }
    const protocols = request.headers["sec-websocket-protocol"]?.split(/,\s*/);
    if (request.url !== "/ws" || !protocols?.includes(subprotocol)) {
      denyUpgrade(socket, "400 Bad Request");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit("connection", client);
    });
  });

  const listening = once(server, "listening");
  server.listen(port, host);
  await listening;
  authority = `${host}:${server.address().port}`;
  origin = `http://${authority}`;

  function close() {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { origin, close };
}

async function main() {
  const router = await startMockRouter();
  console.log(`WAMP Mock Router is ready at ${router.origin}`);
  let closing = false;
  function stop() {
    if (closing) return;
    closing = true;
    router.close().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

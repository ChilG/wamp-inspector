import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  isMockProcedure,
  isMockResponse,
  isMockTopic,
} from "../../src/shared/wamp-mock-response.js";

const host = "127.0.0.1";
const subprotocol = "wamp.2.json";
const mockResponsePath = "/mock-response";
const maxMockBody = 32 * 1024;
const maxMockRules = 32;
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

function mockKey(procedure, topic) {
  return JSON.stringify([procedure, topic]);
}

function replyToCall(frame, send, rules) {
  const [, id, , procedure, , kwargs] = frame;
  const topic =
    typeof kwargs?.topic === "string" && kwargs.topic.trim()
      ? kwargs.topic
      : null;
  const key = mockKey(procedure, topic);
  if (rules.has(key)) {
    const reply = rules.get(key);
    rules.delete(key);
    if (reply) {
      const idIndex = reply[0] === 50 ? 1 : 2;
      send(reply.map((value, index) => (index === idIndex ? id : value)));
    }
    return;
  }
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

async function readMockBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxMockBody) return { status: 413 };
    chunks.push(chunk);
  }
  return { rule: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

function isMockRule(rule) {
  return (
    isObject(rule) &&
    typeof rule.token === "string" &&
    isMockProcedure(rule.procedure) &&
    isMockTopic(rule.topic) &&
    isMockResponse(rule.response)
  );
}

async function handleMockResponse(request, response, origin, sessions) {
  const requester = request.headers.origin;
  if (
    requester &&
    requester !== origin &&
    !/^chrome-extension:\/\/[a-p]{32}$/.test(requester)
  ) {
    response.writeHead(403).end();
    return;
  }

  const headers = { "Cache-Control": "no-store", Vary: "Origin" };
  if (requester) headers["Access-Control-Allow-Origin"] = requester;
  if (request.method === "OPTIONS") {
    response
      .writeHead(204, {
        ...headers,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      })
      .end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { ...headers, Allow: "POST, OPTIONS" }).end();
    return;
  }
  if (
    request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    response.writeHead(415, headers).end();
    return;
  }

  let rule;
  try {
    const body = await readMockBody(request);
    if (body.status === 413) {
      request.resume();
      response.writeHead(413, { ...headers, Connection: "close" }).end();
      return;
    }
    rule = body.rule;
  } catch {
    if (!response.destroyed) response.writeHead(400, headers).end();
    return;
  }

  if (!isMockRule(rule)) {
    response.writeHead(400, headers).end();
    return;
  }
  const session = sessions.get(rule.token);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    response.writeHead(404, headers).end();
    return;
  }
  const key = mockKey(rule.procedure, rule.topic);
  if (!session.rules.has(key) && session.rules.size >= maxMockRules) {
    response.writeHead(409, headers).end();
    return;
  }
  session.rules.set(key, rule.response);
  response.writeHead(204, headers).end();
}

function denyUpgrade(socket, status) {
  socket.once("error", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

function handleSession(socket, sessionId, sessions) {
  let welcomed = false;
  const token = randomUUID();
  const rules = new Map();
  const send = (frame) => socket.send(JSON.stringify(frame));
  const reject = () => socket.close(1002, "Invalid WAMP message");

  socket.on("error", () => socket.terminate());
  socket.once("close", () => sessions.delete(token));
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
      sessions.set(token, { socket, rules });
      send([2, sessionId, { roles: { dealer: {} }, x_mock_control: token }]);
      return;
    }

    if (frame[0] === 48 && isCall(frame)) {
      return replyToCall(frame, send, rules);
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
  const sessions = new Map();

  const server = createServer((request, response) => {
    if (request.headers.host !== authority) {
      response.writeHead(404).end();
      return;
    }
    if (request.url === mockResponsePath) {
      void handleMockResponse(request, response, origin, sessions);
      return;
    }
    const asset = demo.get(request.url);
    if (!asset || request.method !== "GET") {
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
  sockets.on("connection", (socket) =>
    handleSession(socket, nextSessionId++, sessions),
  );
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

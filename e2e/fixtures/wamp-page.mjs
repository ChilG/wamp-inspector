import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

function shell(frameSource, prependFrame) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>WAMP replay fixture</title>
<button id="sports" type="button">Sports</button>
<button id="football" type="button">Football</button>
${prependFrame ? '<iframe title="Placeholder" hidden></iframe>' : ""}
<iframe id="app" title="WAMP app" src="${frameSource}" width="640" height="300"></iframe>
<script>
  const app = document.querySelector('#app').contentWindow;
  document.querySelector('#sports').addEventListener('click', () => {
    history.pushState(null, '', '/');
    app.history.pushState(null, '', '/app');
  });
  document.querySelector('#football').addEventListener('click', () => {
    history.pushState(null, '', '/sport/football');
    app.history.pushState(null, '', '/app/football');
  });
</script>
</html>`;
}

function appPage(startupCallId, startupTopic) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>WAMP replay fixture</title>
<p role="status" aria-label="Connection status">Connecting</p>
<form>
  <label>Procedure <input name="procedure" value="demo.success"></label>
  <label>Topic <input name="topic" value="score.live"></label>
  <label>Server reply <select name="mode">
    <option value="result">Result</option>
    <option value="hold">Hold result</option>
    <option value="error">Error</option>
  </select></label>
  <button disabled>Send CALL</button>
</form>
<p role="status" aria-label="CALL state"></p>
<pre id="reply" role="log" aria-label="Reply frame"></pre>
<script>
  const connection = document.querySelector('[aria-label="Connection status"]');
  const state = document.querySelector('[aria-label="CALL state"]');
  const reply = document.querySelector('#reply');
  const form = document.querySelector('form');
  const send = form.querySelector('button');
  const socket = new WebSocket('ws://' + location.host + '/wire', 'wamp.2.json');
  const startupCallId = ${JSON.stringify(startupCallId)};
  const startupTopic = ${JSON.stringify(startupTopic)};
  let nextId = 0;

  socket.addEventListener('open', () => socket.send(JSON.stringify([
    1, 'fixture', { roles: { caller: {} } }
  ])));
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (frame[0] === 2) {
      connection.textContent = 'Connected';
      send.disabled = false;
      if (startupCallId &&
        window.parent.performance.getEntriesByType('navigation')[0]?.type === 'reload') {
        nextId = startupCallId - 1;
        if (startupTopic !== null) form.elements.topic.value = startupTopic;
        form.requestSubmit();
      }
    } else if (frame[0] === 50 || frame[0] === 8) {
      const id = frame[0] === 50 ? frame[1] : frame[2];
      state.textContent = 'Received #' + id;
      reply.textContent = JSON.stringify(frame);
      reply.dataset.trusted = String(event.isTrusted);
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const id = ++nextId;
    state.textContent = 'Waiting #' + id;
    reply.textContent = '';
    socket.send(JSON.stringify([
      48, id, {}, data.get('procedure'), [],
      { topic: data.get('topic'), mode: data.get('mode') }
    ]));
  });
</script>
</html>`;
}

/** @param {{startupCallId?: number, startupTopic?: string, rotatingFrameQuery?: boolean, prependFrameOnFirstLoad?: boolean}} [options] */
export async function startWampPage({
  startupCallId,
  startupTopic,
  rotatingFrameQuery,
  prependFrameOnFirstLoad,
} = {}) {
  const page = appPage(startupCallId ?? 0, startupTopic ?? null);
  let pageLoads = 0;
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://fixture.invalid");
    if (!["/", "/sport/football", "/app", "/app/football"].includes(pathname)) {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (pathname === "/app" || pathname === "/app/football") {
      response.end(page);
      return;
    }
    const route = pathname === "/sport/football" ? "/app/football" : "/app";
    pageLoads += 1;
    const frameSource = rotatingFrameQuery
      ? `${route}?instance=${pageLoads}`
      : route;
    response.end(
      shell(frameSource, prependFrameOnFirstLoad && pageLoads === 1),
    );
  });
  const sockets = new WebSocketServer({ path: "/wire", server });
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {unknown[][]} */
  const replies = [];
  /** @type {Map<number, () => void>} */
  const held = new Map();
  let connectionCount = 0;

  sockets.on("connection", (socket) => {
    connectionCount += 1;
    function send(frame) {
      replies.push(frame);
      socket.send(JSON.stringify(frame));
    }
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      calls.push(frame);
      if (frame[0] === 1) {
        send([2, 1, { roles: { dealer: {} } }]);
        return;
      }
      const [, id, , , , { mode }] = frame;
      if (mode === "error") {
        send([8, 48, id, {}, "fixture.failed"]);
        return;
      }
      const result = [50, id, { sequence: id }, [`server-${id}`], { wire: id }];
      if (mode === "hold") held.set(id, () => send(result));
      else send(result);
    });
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a local HTTP listener");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    calls,
    replies,
    get connectionCount() {
      return connectionCount;
    },
    /** @param {number} id */
    release(id) {
      const send = held.get(id);
      if (!send) throw new Error(`No held reply for CALL #${id}`);
      held.delete(id);
      send();
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      });
    },
  };
}

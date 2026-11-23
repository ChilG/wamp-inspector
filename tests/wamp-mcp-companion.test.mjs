import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  decodeNativeMessages,
  encodeNativeMessage,
  validRequest,
} from "../tools/mcp/protocol.js";
import { requestCapture } from "../tools/mcp/socket-client.js";

const extensionOrigin = `chrome-extension://${"a".repeat(32)}/`;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "wamp-mcp-"));
  const path = join(dir, "bridge.sock");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path;
}

function entryPath(entry) {
  return fileURLToPath(new URL(`../tools/mcp/${entry}`, import.meta.url));
}

function start(t, entry, args, socketPath) {
  const proc = spawn(process.execPath, [entryPath(entry), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WAMP_INSPECTOR_SOCKET: socketPath },
  });
  const exit = once(proc, "exit");
  t.after(async () => {
    proc.stdin.end();
    await exit;
  });
  return { proc, exit };
}

test("native frames survive split headers and concatenated messages", async () => {
  const first = encodeNativeMessage({ type: "ready" });
  const second = encodeNativeMessage({ id: "2", result: {} });
  async function* chunks() {
    yield first.subarray(0, 2);
    yield Buffer.concat([first.subarray(2), second]);
  }
  const messages = [];
  for await (const message of decodeNativeMessages(chunks())) {
    messages.push(message);
  }
  assert.deepEqual(messages, [{ type: "ready" }, { id: "2", result: {} }]);
});

test(
  "stdio MCP exposes both read-only tools and gives an actionable error before sharing",
  { timeout: 6000 },
  async (t) => {
    const socketPath = await fixture(t);
    const client = new Client({
      name: "wamp-inspector-tests",
      version: "1.0.0",
    });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [entryPath("server.js")],
        env: { WAMP_INSPECTOR_SOCKET: socketPath },
        stderr: "pipe",
      }),
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "inspect_wamp_messages",
      "list_wamp_connections",
    ]);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint === true));

    const notSharing = await client.callTool({
      name: "list_wamp_connections",
      arguments: {},
    });
    assert.equal(notSharing.isError, true);
    assert.match(notSharing.content[0].text, /Share with MCP/);

    const largestId = await client.callTool({
      name: "inspect_wamp_messages",
      arguments: { connectionId: "test", requestId: 2 ** 53 },
    });
    assert.equal(largestId.isError, true);
    assert.match(largestId.content[0].text, /Share with MCP/);
    assert.equal(
      validRequest("inspect_wamp_messages", {
        connectionId: "test",
        requestId: 2 ** 53,
      }),
      true,
    );

    assert.equal(
      validRequest("inspect_wamp_messages", {
        connectionId: "test",
        requestId: "9007199254740993",
      }),
      false,
    );

    const invalid = await client.callTool({
      name: "inspect_wamp_messages",
      arguments: { connectionId: "test", limit: 201 },
    });
    assert.equal(invalid.isError, true);
  },
);

test(
  "installer registers one extension in its Chrome profile and leaves unrelated files intact",
  { skip: process.platform !== "darwin", timeout: 6000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "wamp-install-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "bridge.sock");
    const directory = join(dir, "NativeMessagingHosts");
    const manifestFile = join(directory, "com.wamp_inspector.bridge.json");
    async function run(argument) {
      const proc = spawn(
        process.execPath,
        [entryPath("install.js"), argument],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            WAMP_INSPECTOR_SOCKET: socketPath,
            WAMP_INSPECTOR_CHROME_DATA_DIR: dir,
          },
        },
      );
      const [code] = await once(proc, "exit");
      return code;
    }

    assert.equal(await run("a".repeat(32)), 0);
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    assert.deepEqual(manifest.allowed_origins, [extensionOrigin]);
    assert.equal(manifest.type, "stdio");
    assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);
    assert.ok((await readFile(manifest.path, "utf8")).includes(socketPath));
    const unrelated = join(directory, "another.host.json");
    await writeFile(unrelated, "{}");
    assert.equal(await run("--uninstall"), 0);
    assert.equal(await readFile(unrelated, "utf8"), "{}");
    await assert.rejects(stat(manifestFile), { code: "ENOENT" });
    await assert.rejects(stat(manifest.path), { code: "ENOENT" });
  },
);

test("native decoder rejects oversized and incomplete messages", async () => {
  const oversized = Buffer.alloc(4, 0xff);
  const incomplete = encodeNativeMessage({ type: "ready" }).subarray(0, 7);
  for (const bytes of [oversized, incomplete]) {
    await assert.rejects(async () => {
      for await (const message of decodeNativeMessages([bytes])) {
        assert.fail(`Unexpected message ${message.type}`);
      }
    });
  }
});

test(
  "forwards read-only requests through a private socket and stops when Chrome leaves",
  { timeout: 6000 },
  async (t) => {
    const socketPath = await fixture(t);
    const { proc, exit } = start(
      t,
      "native-host.js",
      [extensionOrigin],
      socketPath,
    );
    const messages = decodeNativeMessages(proc.stdout);
    assert.deepEqual((await messages.next()).value, { type: "ready" });
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);

    const request = requestCapture("list_wamp_connections", {}, { socketPath });
    const { value } = await messages.next();
    assert.equal(value.method, "list_wamp_connections");
    const result = {
      connections: [{ connectionId: "test", retainedCount: 0 }],
    };
    await new Promise((resolve, reject) => {
      proc.stdin.write(
        encodeNativeMessage({ id: value.id, result }),
        (error) => (error ? reject(error) : resolve()),
      );
    });
    assert.deepEqual(await request, result);
    await assert.rejects(requestCapture("send_frame", {}, { socketPath }), {
      code: "INVALID_REQUEST",
    });
    const disconnected = requestCapture(
      "list_wamp_connections",
      {},
      { socketPath },
    );
    assert.equal((await messages.next()).value.method, "list_wamp_connections");
    const failure = assert.rejects(disconnected, { code: "NOT_SHARING" });
    proc.stdin.end();
    await failure;
    assert.deepEqual(await exit, [0, null]);
    await assert.rejects(
      requestCapture("list_wamp_connections", {}, { socketPath }),
      { code: "NOT_SHARING" },
    );
  },
);

test(
  "keeps an active host and recovers a socket left after a crash",
  { timeout: 6000 },
  async (t) => {
    const socketPath = await fixture(t);
    const first = start(t, "native-host.js", [extensionOrigin], socketPath);
    const firstMessages = decodeNativeMessages(first.proc.stdout);
    assert.deepEqual((await firstMessages.next()).value, { type: "ready" });

    const second = start(t, "native-host.js", [extensionOrigin], socketPath);
    const secondMessages = decodeNativeMessages(second.proc.stdout);
    const { value } = await secondMessages.next();
    assert.equal(value.type, "error");
    assert.match(value.message, /already sharing/);
    assert.deepEqual(await second.exit, [1, null]);

    first.proc.kill("SIGKILL");
    assert.deepEqual(await first.exit, [null, "SIGKILL"]);
    assert.equal((await stat(socketPath)).isSocket(), true);
    await symlink(String(first.proc.pid), `${socketPath}.recovery`);

    const replacement = start(
      t,
      "native-host.js",
      [extensionOrigin],
      socketPath,
    );
    const replacementMessages = decodeNativeMessages(replacement.proc.stdout);
    assert.deepEqual((await replacementMessages.next()).value, {
      type: "ready",
    });
    replacement.proc.stdin.end();
    assert.deepEqual(await replacement.exit, [0, null]);
    await assert.rejects(stat(socketPath), { code: "ENOENT" });
  },
);

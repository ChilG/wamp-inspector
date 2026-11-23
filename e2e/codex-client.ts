import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type ToolResult = { structuredContent?: unknown; isError?: boolean };
type Reply = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export async function openCodexClient(socket: string) {
  const registration = {
    command: process.execPath,
    args: [resolve("tools/mcp/server.js")],
    env: { WAMP_INSPECTOR_SOCKET: socket },
  };
  const argumentsToml = registration.args
    .map((value) => JSON.stringify(value))
    .join(",");
  const config = `mcp_servers={wamp_inspector={command=${JSON.stringify(registration.command)},args=[${argumentsToml}],env={WAMP_INSPECTOR_SOCKET=${JSON.stringify(socket)}}}}`;
  const child = spawn(
    "codex",
    ["app-server", "--stdio", "-c", config, "-c", "analytics.enabled=false"],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const pending = new Map<number, Reply>();
  let id = 0;

  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const { id, result, error } = JSON.parse(line);
    const request = pending.get(id);
    if (error) request?.reject(new Error(error.message));
    else request?.resolve(result);
  });

  function abort(error: Error) {
    for (const request of pending.values()) request.reject(error);
  }
  child.on("error", abort);
  child.on("exit", (code) =>
    abort(new Error(`Codex app-server exited with status ${code}`)),
  );

  function request<T>(method: string, params: object) {
    const requestId = ++id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Codex timed out during ${method}`)),
        10000,
      );
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timer);
        pending.delete(requestId);
        if (error) reject(error);
        else resolve(value as T);
      }
      pending.set(requestId, {
        resolve: (value) => finish(undefined, value),
        reject: finish,
      });
      child.stdin.write(
        JSON.stringify({ id: requestId, method, params }) + "\n",
        (error) => {
          if (error) finish(error);
        },
      );
    });
  }

  async function close() {
    output.close();
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const exited = once(child, "exit");
    child.stdin.end();
    child.kill();
    await exited;
  }

  try {
    await request("initialize", {
      clientInfo: { name: "wamp-inspector-e2e", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const { thread } = await request<{ thread: { id: string } }>(
      "thread/start",
      {
        cwd: process.cwd(),
        ephemeral: true,
      },
    );
    return {
      callTool: ({
        name,
        arguments: params,
      }: {
        name: string;
        arguments: object;
      }) =>
        request<ToolResult>("mcpServer/tool/call", {
          threadId: thread.id,
          server: "wamp_inspector",
          tool: name,
          arguments: params,
        }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

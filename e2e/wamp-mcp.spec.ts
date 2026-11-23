import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  chromium,
  devices,
  expect,
  test,
  type CDPSession,
  type Locator,
} from "@playwright/test";
import { startMockRouter } from "../tools/mock-wamp/server.mjs";
import { openCodexClient } from "./codex-client.js";

const runFile = promisify(execFile);

type Target = { targetId: string; url: string };
type CdpReply = {
  id: number;
  result?: { result: { value?: unknown }; exceptionDetails?: { text: string } };
  error?: { message: string };
};

async function expectReadableControl(control: Locator) {
  const contrast = await control.evaluate((element) => {
    function luminance(rgb: string) {
      const channels = rgb
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map((value) => Number(value) / 255);
      const [r, g, b] = channels.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const style = getComputedStyle(element);
    const values = [luminance(style.color), luminance(style.backgroundColor)];
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
}

async function attach(root: CDPSession, targetId: string) {
  const { sessionId } = await root.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let sequence = 0;
  // Attach to DevTools and its extension iframe through the browser CDP session.
  return function evaluate<T>(expression: string, userGesture = false) {
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Chrome CDP timed out")),
        5000,
      );
      function finish(error?: Error, value?: unknown) {
        clearTimeout(timer);
        root.off("Target.receivedMessageFromTarget", receive);
        if (error) reject(error);
        else resolve(value as T);
      }
      function receive(event: { sessionId: string; message: string }) {
        if (event.sessionId !== sessionId) return;
        const reply = JSON.parse(event.message) as CdpReply;
        if (reply.id !== id) return;
        const error =
          reply.error?.message ?? reply.result?.exceptionDetails?.text;
        finish(
          error ? new Error(error) : undefined,
          reply.result?.result.value,
        );
      }
      root.on("Target.receivedMessageFromTarget", receive);
      void root
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: {
              expression,
              userGesture,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        })
        .catch(finish);
    });
  };
}

async function waitForTarget(
  root: CDPSession,
  matches: (target: Target) => boolean,
) {
  let target: Target | undefined;
  await expect
    .poll(async () => {
      target = (await root.send("Target.getTargets")).targetInfos.find(matches);
      return Boolean(target);
    })
    .toBe(true);
  return target!.targetId;
}

async function openInspector(root: CDPSession, existing: Set<string>) {
  const devtools = await waitForTarget(
    root,
    (target) =>
      !existing.has(target.targetId) && target.url.startsWith("devtools://"),
  );
  const evaluate = await attach(root, devtools);
  await expect
    .poll(() =>
      evaluate<boolean>(`(async () => {
    if (!document.querySelector('iframe[data-devtools-extension="WAMP Inspector"]')) return false;
    const { InspectorView } = await import('./ui/legacy/legacy.js');
    const inspector = InspectorView.InspectorView.instance();
    const pane = inspector.tabbedPane.tabsHistory.find(tab => tab.title === 'WAMP Inspector');
    if (!pane) return false;
    await inspector.showPanel(pane.id);
    return true;
  })()`),
    )
    .toBe(true);
  const panel = await waitForTarget(root, (target) =>
    target.url.endsWith("/src/devtools/panel.html"),
  );
  const inspect = await attach(root, panel);
  const status = () =>
    inspect<string>("document.querySelector('#mcp-share-status')?.textContent");
  const click = () =>
    inspect("document.querySelector('#mcp-share').click()", true);
  await expect
    .poll(() => inspect("document.querySelector('#mcp-share')?.textContent"))
    .toBe("Share with MCP");
  return { devtools, status, click, inspect };
}

async function prepareExtension(directory: string) {
  if (process.env.WAMP_INSPECTOR_E2E_PROMPT === "1") return process.cwd();
  const extension = join(directory, "extension");
  await mkdir(extension);
  await Promise.all(
    ["src", "icons"].map((name) =>
      cp(resolve(name), join(extension, name), { recursive: true }),
    ),
  );
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  // Pregrant in the disposable extension copy for unattended runs. The real permission
  // prompt can be tested by setting WAMP_INSPECTOR_E2E_PROMPT and accepting it in Chrome.
  manifest.permissions.push("nativeMessaging");
  manifest.optional_permissions = manifest.optional_permissions.filter(
    (permission: string) => permission !== "nativeMessaging",
  );
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  return extension;
}

test("Chrome shares live WAMP results with MCP and revokes access", async () => {
  test.skip(
    process.platform !== "darwin",
    "Google Chrome Native Messaging integration targets macOS",
  );
  test.setTimeout(45000);
  const directory = await mkdtemp(join(tmpdir(), "wamp-e2e-"));
  const profile = join(directory, "chrome");
  const socket = join(directory, "bridge.sock");
  const environment = {
    ...process.env,
    WAMP_INSPECTOR_CHROME_DATA_DIR: profile,
    WAMP_INSPECTOR_SOCKET: socket,
  };
  const router = await startMockRouter({ port: 0 });
  const client = new Client({ name: "wamp-inspector-e2e", version: "1.0.0" });
  let chrome:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let mcp: Client | Awaited<ReturnType<typeof openCodexClient>> = client;

  try {
    chrome = await chromium.launchPersistentContext(profile, {
      channel: "chrome",
      headless: false,
      chromiumSandbox: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        "--auto-open-devtools-for-tabs",
      ],
    });
    const root = await chrome.browser()!.newBrowserCDPSession();
    const { id } = await root.send("Extensions.loadUnpacked", {
      path: await prepareExtension(directory),
    });
    await runFile(process.execPath, ["tools/mcp/install.js", id], {
      env: environment,
    });
    if (process.env.WAMP_INSPECTOR_E2E_CODEX === "1") {
      mcp = await openCodexClient(socket);
    } else {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve("tools/mcp/server.js")],
          env: { WAMP_INSPECTOR_SOCKET: socket },
        }),
      );
    }

    const list = () =>
      mcp.callTool({ name: "list_wamp_connections", arguments: {} });
    expect((await list()).isError).toBe(true);
    const targets = async () =>
      new Set(
        (await root.send("Target.getTargets")).targetInfos.map(
          (target) => target.targetId,
        ),
      );
    const existing = await targets();
    const pageReady = chrome.waitForEvent("page");
    await root.send("Target.createTarget", { url: router.origin });
    const page = await pageReady;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");
    const panel = await openInspector(root, existing);
    await panel.click();
    await expect
      .poll(panel.status, {
        timeout: process.env.WAMP_INSPECTOR_E2E_PROMPT ? 20000 : 8000,
      })
      .toBe("Sharing WAMP metadata from this tab.");

    const otherPage = chrome.waitForEvent("page");
    await root.send("Target.createTarget", { url: router.origin });
    const other = await otherPage;
    await expect(
      other.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");
    await other.getByLabel("Scenario").selectOption({ label: "Error" });
    await other.getByRole("button", { name: "Send CALL" }).click();
    await expect(
      other.getByRole("status", { name: "Call result" }),
    ).toContainText("Error.");

    const connectionResponse = await list();
    expect(connectionResponse.structuredContent).toEqual({
      connections: [
        expect.objectContaining({ protocol: "wamp.2.json", state: "OPEN" }),
      ],
    });
    const { connections } = connectionResponse.structuredContent as {
      connections: { connectionId: string }[];
    };
    const inspectCalls = () =>
      mcp.callTool({
        name: "inspect_wamp_messages",
        arguments: { connectionId: connections[0].connectionId, type: "CALL" },
      });
    expect((await inspectCalls()).structuredContent).toEqual({
      messages: [],
      truncated: false,
    });

    const scenarios = [
      {
        label: "Success",
        text: /Success.*request 1/,
        id: 1,
        status: "success",
        response: "RESULT",
      },
      {
        label: "Error",
        text: /Error.*request 2/,
        id: 2,
        status: "error",
        response: "ERROR",
      },
      {
        label: "No response",
        text: /Timed out.*request 3/,
        id: 3,
        status: "pending",
        response: null,
      },
    ];
    for (const scenario of scenarios) {
      await page.getByLabel("Scenario").selectOption({ label: scenario.label });
      await page.getByRole("button", { name: "Send CALL" }).click();
      await expect(
        page.getByRole("status", { name: "Call result" }),
      ).toHaveText(scenario.text);
      await expect
        .poll(async () => (await inspectCalls()).structuredContent)
        .toEqual({
          messages: expect.arrayContaining([
            expect.objectContaining({
              requestId: scenario.id,
              status: scenario.status,
              responseType: scenario.response,
            }),
          ]),
          truncated: false,
        });
    }
    expect(
      JSON.stringify((await inspectCalls()).structuredContent),
    ).not.toContain("Mock result");
    await expect
      .poll(() => panel.inspect("document.body.innerText"))
      .toContain("demo.no_response");
    expect(errors).toEqual([]);
    await expectReadableControl(
      page.getByRole("button", { name: "Send CALL" }),
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path: test.info().outputPath("wamp-demo.png") });

    await panel.click();
    await expect.poll(panel.status).toContain("stopped");
    await expect.poll(async () => (await list()).isError).toBe(true);
    await panel.click();
    await expect.poll(panel.status).toContain("Sharing WAMP metadata");
    await page.reload();
    await expect.poll(async () => (await list()).isError).toBe(true);
    await panel.click();
    await expect.poll(panel.status).toContain("Sharing WAMP metadata");
    await root.send("Target.closeTarget", { targetId: panel.devtools });
    await expect.poll(async () => (await list()).isError).toBe(true);
  } finally {
    await mcp.close();
    await chrome?.close();
    await router.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mock demo fits a narrow viewport and exposes keyboard controls", async () => {
  const router = await startMockRouter({ port: 0 });
  const browser = await chromium.launch({
    channel: "chrome",
    chromiumSandbox: true,
  });
  try {
    const { defaultBrowserType, ...viewport } = devices["Pixel 7"];
    const page = await browser.newPage(viewport);
    await page.goto(router.origin, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");
    const scenario = page.getByRole("combobox", { name: "Scenario" });
    await scenario.focus();
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send CALL" });
    await expect(send).toBeFocused();
    await expectReadableControl(send);
    const box = await send.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("status", { name: "Call result" }),
    ).toContainText("Success.");
    await page.screenshot({
      path: test.info().outputPath("wamp-demo-narrow.png"),
    });
  } finally {
    await browser.close();
    await router.close();
  }
});

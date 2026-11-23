import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type FrameLocator,
  type Page,
} from "@playwright/test";
import { startWampPage } from "./wamp-page.mjs";

type Target = { targetId: string; type: string; url: string };
type CdpReply<T> = {
  id: number;
  result?: T;
  error?: { message: string };
};

async function attach(root: CDPSession, targetId: string) {
  const { sessionId } = await root.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let sequence = 0;
  // Attach to DevTools and its extension iframe through the browser CDP session.
  function command<T>(method: string, params: object) {
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
        const reply = JSON.parse(event.message) as CdpReply<T>;
        if (reply.id !== id) return;
        finish(reply.error && new Error(reply.error.message), reply.result);
      }
      root.on("Target.receivedMessageFromTarget", receive);
      void root
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(finish);
    });
  }
  async function evaluate<T>(expression: string, userGesture = false) {
    const evaluation = await command<{
      result: { value?: T };
      exceptionDetails?: { text: string };
    }>("Runtime.evaluate", {
      expression,
      userGesture,
      returnByValue: true,
      awaitPromise: true,
    });
    if (evaluation.exceptionDetails)
      throw new Error(evaluation.exceptionDetails.text);
    return evaluation.result.value;
  }
  return { command, evaluate };
}

export async function captureDevTools(
  frontend: Awaited<ReturnType<typeof attach>>,
  filename: string,
) {
  let data: string;
  try {
    ({ data } = await frontend.command<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", fromSurface: false },
    ));
  } catch (error) {
    // Native window capture can be unavailable in a headed test session.
    if (
      error instanceof Error &&
      error.message === "Unable to capture screenshot"
    )
      return;
    throw error;
  }
  await writeFile(
    test.info().outputPath(filename),
    Buffer.from(data, "base64"),
  );
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

async function restartExtensionWorker(
  root: CDPSession,
  context: BrowserContext,
  extensionId: string,
) {
  const workerUrl = `chrome-extension://${extensionId}/src/capture/background.js`;
  const targetId = await waitForTarget(
    root,
    (target) => target.type === "service_worker" && target.url === workerUrl,
  );
  const currentWorker = () =>
    context.serviceWorkers().find((worker) => worker.url() === workerUrl);
  const worker =
    currentWorker() ??
    (await context.waitForEvent(
      "serviceworker",
      (worker) => worker.url() === workerUrl,
    ));
  const originalStart = await worker.evaluate(() => performance.timeOrigin);
  const { success } = await root.send("Target.closeTarget", { targetId });
  expect(success).toBe(true);

  // A CDP target and its Playwright Worker handle can survive a restart.
  // The Inspector reconnects; verify that its worker has a new JS runtime.
  await expect
    .poll(async () => {
      try {
        return (
          (await currentWorker()?.evaluate(() => performance.timeOrigin)) ??
          originalStart
        );
      } catch {
        return originalStart;
      }
    })
    .toBeGreaterThan(originalStart);
}

async function openInspector(root: CDPSession, existing: Set<string>) {
  const devtools = await waitForTarget(
    root,
    (target) =>
      !existing.has(target.targetId) && target.url.startsWith("devtools://"),
  );
  const frontend = await attach(root, devtools);
  await expect
    .poll(() =>
      frontend.evaluate<boolean>(`(async () => {
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
  const { evaluate } = await attach(root, panel);
  return { inspect: evaluate, frontend };
}

export type InspectPanel = Awaited<ReturnType<typeof openInspector>>["inspect"];

type WampFixture = Awaited<ReturnType<typeof startWampPage>>;
type InspectorFixture = {
  fixture: WampFixture;
  page: Page;
  app: FrameLocator;
  inspect: InspectPanel;
  frontend: Awaited<ReturnType<typeof attach>>;
  restartWorker: () => Promise<void>;
};

export async function withInspector(
  run: (context: InspectorFixture) => Promise<void>,
  options?: Parameters<typeof startWampPage>[0],
) {
  const directory = await mkdtemp(join(tmpdir(), "wamp-e2e-"));
  let fixture: WampFixture | undefined;
  let chrome:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  try {
    fixture = await startWampPage(options);
    chrome = await chromium.launchPersistentContext(directory, {
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
      path: process.cwd(),
    });
    const existing = new Set(
      (await root.send("Target.getTargets")).targetInfos.map(
        (target) => target.targetId,
      ),
    );
    const pageReady = chrome.waitForEvent("page");
    await root.send("Target.createTarget", { url: fixture.origin });
    const page = await pageReady;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const app = page.frameLocator('iframe[title="WAMP app"]');
    await expect(
      app.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");

    const { inspect, frontend } = await openInspector(root, existing);
    await run({
      fixture,
      page,
      app,
      inspect,
      frontend,
      restartWorker: () => restartExtensionWorker(root, page.context(), id),
    });
    expect(errors).toEqual([]);
  } finally {
    await chrome?.close();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  devices,
  expect,
  test,
  type CDPSession,
  type Locator,
} from "@playwright/test";
import { startMockRouter } from "../tools/mock-wamp/server.mjs";

type Target = { targetId: string; url: string };
type CdpReply<T> = {
  id: number;
  result?: T;
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

test("sends all mock CALL scenarios from WAMP Inspector and captures their outcomes", async () => {
  test.setTimeout(45000);
  const directory = await mkdtemp(join(tmpdir(), "wamp-e2e-"));
  let router: Awaited<ReturnType<typeof startMockRouter>> | undefined;
  let chrome:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  try {
    router = await startMockRouter({ port: 0 });
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
    await root.send("Extensions.loadUnpacked", { path: process.cwd() });
    const existing = new Set(
      (await root.send("Target.getTargets")).targetInfos.map(
        (target) => target.targetId,
      ),
    );
    const pageReady = chrome.waitForEvent("page");
    await root.send("Target.createTarget", { url: router.origin });
    const page = await pageReady;
    const errors: string[] = [];
    const workspaceProbe = `${router.origin}/.well-known/appspecific/com.chrome.devtools.json`;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      const detail = message.text();
      // Chrome probes for a workspace when DevTools opens on loopback.
      if (
        message.type() === "error" &&
        !(detail.includes(workspaceProbe) && detail.includes("connect-src"))
      ) {
        errors.push(detail);
      }
    });
    await expect(
      page.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");

    const { inspect, frontend } = await openInspector(root, existing);
    const mockVisible = () =>
      inspect<boolean>(
        "document.querySelector('#mock-open')?.checkVisibility()",
      );
    await expect.poll(mockVisible).toBe(true);

    // Each response is asserted in the inspected page and in its captured CALL row.
    const scenarios = [
      {
        procedure: "demo.success",
        id: 1,
        result: /Success.*request 1/,
        response: "RESULT",
      },
      {
        procedure: "demo.error",
        id: 2,
        result: /Error.*request 2/,
        response: "ERROR",
      },
      {
        procedure: "demo.no_response",
        id: 3,
        result: /Timed out.*request 3/,
        response: null,
      },
    ];
    for (const { procedure, id, result, response } of scenarios) {
      await inspect(
        `(() => {
        const scenario = document.querySelector('#mock-scenario');
        if (!scenario.checkVisibility()) document.querySelector('#mock-open').click();
        scenario.value = ${JSON.stringify(procedure)};
        scenario.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#mock-send').click();
      })()`,
        true,
      );
      if (id === 1) {
        await expect
          .poll(() =>
            inspect(`(() => {
          const controls = document.querySelector('#mock-controls');
          const button = document.querySelector('#mock-send');
          const panel = controls.getBoundingClientRect();
          const trigger = document.querySelector('#mock-open').getBoundingClientRect();
          return controls.matches(':popover-open') &&
            button.checkVisibility() &&
            panel.left >= 0 &&
            panel.top >= trigger.bottom &&
            panel.right <= innerWidth;
        })()`),
          )
          .toBe(true);
      }
      await expect
        .poll(() =>
          inspect("document.querySelector('#mock-status')?.textContent"),
        )
        .toContain(`CALL #${id} sent.`);
      await expect(
        page.getByRole("status", { name: "Call result" }),
      ).toHaveText(result);
      await expect(
        page.getByRole("combobox", { name: "Scenario" }),
      ).toHaveValue(procedure);
      await expect
        .poll(() =>
          inspect(`(() => {
            const row = [...document.querySelectorAll('button[aria-controls="message-inspector"]')]
              .find(button => button.querySelector('.preview')?.textContent === ${JSON.stringify(procedure)});
            if (!row) return null;
            const latency = row.querySelector('.latency');
            return {
              type: row.querySelector('.message-type')?.textContent,
              request: row.querySelector('.request-id')?.textContent,
              response: latency?.title || null,
              pending: latency?.textContent === 'Pending',
            };
          })()`),
        )
        .toEqual({
          type: "CALL",
          request: `#${id}`,
          response,
          pending: response === null,
        });
    }
    expect(errors).toEqual([]);
    const { data } = await frontend.command<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", fromSurface: false },
    );
    await writeFile(
      test.info().outputPath("wamp-devtools-mock.png"),
      Buffer.from(data, "base64"),
    );

    const unrelated = "http://unrelated.example.test/";
    await page.route(unrelated, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Unrelated page</title>",
      }),
    );
    await page.goto(unrelated, { waitUntil: "domcontentloaded" });
    await expect
      .poll(() => inspect("document.querySelector('#inspected-url')?.title"))
      .toBe(unrelated);
    await expect.poll(mockVisible).toBe(false);
  } finally {
    await chrome?.close();
    await router?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mock demo fits a narrow viewport and exposes keyboard controls", async () => {
  const router = await startMockRouter({ port: 0 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      chromiumSandbox: true,
    });
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
    await browser?.close();
    await router.close();
  }
});

import { expect, test, type FrameLocator } from "@playwright/test";
import { captureDevTools, withInspector } from "./fixtures/wamp-inspector.js";

async function sendCall(app: FrameLocator, procedure: string, hold = false) {
  await app.getByRole("textbox", { name: "Procedure" }).fill(procedure);
  await app
    .getByRole("combobox", { name: "Server reply" })
    .selectOption(hold ? "hold" : "result");
  await app.getByRole("button", { name: "Send CALL" }).click();
}

test("opens, highlights, and restores JSON preview tabs per connection", async () => {
  test.setTimeout(45_000);
  await withInspector(async ({ fixture, page, app, inspect, frontend }) => {
    const tabs = () =>
      inspect<
        string[]
      >(`Array.from(document.querySelectorAll('#preview-tabs [role=tab]'),
        (tab) => tab.textContent)`);
    const active = () =>
      inspect<string>(
        "document.querySelector('#preview-tabs [aria-selected=true]')?.textContent",
      );
    const payload = () =>
      inspect<string>(
        "document.querySelector('#payload-contents')?.textContent",
      );
    const panelVisible = () =>
      inspect<boolean>(
        "document.querySelector('#message-inspector').checkVisibility()",
      );
    const closeAll = "document.querySelector('#close-all-preview-tabs')";

    function filterMessages(query: string) {
      return inspect(`(() => {
        const search = document.querySelector('#message-search');
        search.value = ${JSON.stringify(query)};
        search.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }

    async function openRow(procedure: string) {
      const row = `[...document.querySelectorAll('.message-row')].find(
        (row) => row.querySelector('.preview').textContent === ${JSON.stringify(procedure)})`;
      await expect.poll(() => inspect(`Boolean(${row})`)).toBe(true);
      await inspect(`(${row}).querySelector('.preview').click()`, true);
    }

    async function switchConnection() {
      const button =
        "document.querySelector('#connections [aria-pressed=false]')";
      await expect.poll(() => inspect(`Boolean(${button})`)).toBe(true);
      await inspect(
        `(() => {
        const picker = document.querySelector('#socket-picker');
        if (picker.checkVisibility()) {
          picker.value = [...picker.options].find((option) => !option.selected).value;
          picker.dispatchEvent(new Event('change', { bubbles: true }));
        } else ${button}.click();
      })()`,
        true,
      );
    }

    await sendCall(app, "demo.first", true);
    await openRow("demo.first");
    await expect.poll(active, { timeout: 4000 }).toBe("CALL #1");
    await expect.poll(payload).toContain("Waiting for response");
    await sendCall(app, "demo.second");
    await openRow("demo.second");
    await openRow("demo.second");
    await expect.poll(tabs).toEqual(["CALL #1", "CALL #2"]);
    await expect.poll(active).toBe("CALL #2");
    await expect
      .poll(() => inspect(`${closeAll}?.checkVisibility() ?? false`))
      .toBe(true);
    await expect
      .poll(() =>
        inspect(`(() => {
          const tab = document.querySelector('#preview-tabs [aria-selected=true]');
          const row = document.querySelector('.message-row[aria-expanded=true]');
          return [getComputedStyle(tab.parentElement).backgroundColor,
            getComputedStyle(tab.parentElement).borderBottomColor,
            getComputedStyle(row).backgroundColor, row.querySelector('.preview').textContent];
        })()`),
      )
      .toEqual([
        "rgb(37, 64, 94)",
        "rgb(154, 198, 255)",
        "rgb(37, 64, 94)",
        "demo.second",
      ]);
    await captureDevTools(frontend, "wamp-preview-tabs.png");

    function dragFirstTabToEnd(drop: boolean) {
      return inspect(`(() => {
        const list = document.querySelector('#preview-tabs');
        const source = list.querySelector('[role=tab]');
        const end = list.lastElementChild.getBoundingClientRect().right - 1;
        const dataTransfer = new DataTransfer();
        const options = { bubbles: true, cancelable: true, dataTransfer, clientX: end };
        source.dispatchEvent(new DragEvent('dragstart', options));
        list.dispatchEvent(new DragEvent('dragover', options));
        const marker = list.querySelector('[data-drop-after]')?.querySelector('[role=tab]').textContent;
        const labels = [...list.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
        if (${drop}) list.dispatchEvent(new DragEvent('drop', options));
        source.dispatchEvent(new DragEvent('dragend', options));
        return { marker, labels };
      })()`);
    }

    const expectedDrag = { marker: "CALL #2", labels: ["CALL #1", "CALL #2"] };
    expect(await dragFirstTabToEnd(false)).toEqual(expectedDrag);
    await expect.poll(tabs).toEqual(["CALL #1", "CALL #2"]);
    expect(await dragFirstTabToEnd(true)).toEqual(expectedDrag);
    await expect.poll(tabs).toEqual(["CALL #2", "CALL #1"]);
    await expect.poll(active).toBe("CALL #2");

    function moveSelectedTab(key: "ArrowLeft" | "ArrowRight") {
      return inspect(`document.querySelector('#preview-tabs [aria-selected=true]').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)}, altKey: true, shiftKey: true, bubbles: true, cancelable: true,
        })
      )`);
    }
    await moveSelectedTab("ArrowRight");
    await expect.poll(tabs).toEqual(["CALL #1", "CALL #2"]);
    await moveSelectedTab("ArrowLeft");
    await expect.poll(tabs).toEqual(["CALL #2", "CALL #1"]);

    fixture.release(1);
    await expect
      .poll(() =>
        inspect(`[...document.querySelectorAll('.message-row')].find(
          (row) => row.querySelector('.preview').textContent === 'demo.first'
        )?.querySelector('.latency').title`),
      )
      .toBe("RESULT");
    await inspect(`(() => {
      const selected = document.querySelector('#preview-tabs [aria-selected=true]');
      selected.focus();
      selected.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft', bubbles: true, cancelable: true,
      }));
    })()`);
    await expect.poll(active).toBe("CALL #1");
    await inspect(
      `(() => {
      document.querySelector('#toggle-payload-search').click();
      const query = document.querySelector('#payload-query');
      query.value = 'server-1';
      query.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
      true,
    );
    await expect
      .poll(() =>
        inspect("document.querySelector('#payload-match-count').textContent"),
      )
      .toBe("1 / 1");

    await filterMessages("#2");
    await expect.poll(panelVisible).toBe(true);
    await expect.poll(active).toBe("CALL #1");
    await inspect("document.querySelector('#close-inspector').click()", true);
    await expect.poll(panelVisible).toBe(false);
    await openRow("demo.second");
    await expect.poll(tabs).toEqual(["CALL #2", "CALL #1"]);
    await inspect("document.querySelector('#close-inspector').click()", true);

    const longConnection = "live-sports-connection-".repeat(5) + "fixture";
    await page.evaluate((connection) => {
      const frame = document.createElement("iframe");
      frame.title = "Second WAMP app";
      frame.src = "/app?connection=" + encodeURIComponent(connection);
      document.body.append(frame);
    }, longConnection);
    const secondApp = page.frameLocator('iframe[title="Second WAMP app"]');
    await expect(
      secondApp.getByRole("status", { name: "Connection status" }),
    ).toHaveText("Connected");
    await sendCall(secondApp, "demo.other");
    await switchConnection();
    await expect.poll(panelVisible).toBe(false);
    await filterMessages("");
    await openRow("demo.other");
    await expect.poll(tabs).toEqual(["CALL #1"]);
    await expect.poll(payload).toContain("demo.other");
    await switchConnection();
    await expect.poll(tabs).toEqual(["CALL #2", "CALL #1"]);
    await expect.poll(active).toBe("CALL #2");

    await inspect(
      "document.querySelector('#preview-tabs [aria-label=\"Close CALL #2\"]').click()",
      true,
    );
    await expect.poll(active).toBe("CALL #1");
    await inspect(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete', bubbles: true, cancelable: true,
    }))`);
    await expect.poll(panelVisible).toBe(false);
    await expect
      .poll(() =>
        inspect(
          "document.activeElement?.querySelector('.preview')?.textContent",
        ),
      )
      .toBe("demo.first");

    async function resizeInspector(width: number) {
      await frontend.evaluate(`(() => {
        function findPanelFrame(root) {
          const frame = root.querySelector('iframe[src$="/src/devtools/panel.html"]');
          if (frame) return frame;
          for (const element of root.querySelectorAll('*')) {
            if (!element.shadowRoot) continue;
            const nested = findPanelFrame(element.shadowRoot);
            if (nested) return nested;
          }
        }
        const frame = findPanelFrame(document);
        frame.style.setProperty('flex', '0 0 ${width}px', 'important');
        frame.style.setProperty('width', '${width}px', 'important');
        frame.style.setProperty('min-width', '0', 'important');
        frame.style.setProperty('max-width', '${width}px', 'important');
      })()`);
      await expect.poll(() => inspect("window.innerWidth")).toBe(width);
    }

    async function expectCompactConnection(connection = "") {
      const query = connection
        ? "?connection=" + encodeURIComponent(connection)
        : "";
      await expect
        .poll(() =>
          inspect(`(() => {
        const endpoint = document.querySelector('#socket-picker-endpoint');
        const status = document.querySelector('#socket-picker-status');
        const meta = document.querySelector('#socket-picker-meta');
        const picker = document.querySelector('#socket-picker');
        if (!endpoint || !status || !meta || !picker.checkVisibility()) return null;
        const frame = [...document.querySelectorAll('#connections .connection')]
          .find((button) => button.getAttribute('aria-pressed') === 'true').querySelector('.frame');
        return {
          endpoint: endpoint.textContent,
          state: status.dataset.state,
          frameMatches: meta.textContent.includes(frame.textContent),
          twoLines: endpoint.getBoundingClientRect().bottom <= meta.getBoundingClientRect().top,
          overflow: endpoint.scrollWidth > endpoint.clientWidth,
          ellipsis: getComputedStyle(endpoint).textOverflow === 'ellipsis',
          fullAddress: picker.title === 'ws://' + endpoint.textContent,
        };
      })()`),
        )
        .toEqual({
          endpoint: new URL(fixture.origin).host + "/wire" + query,
          state: "OPEN",
          frameMatches: true,
          twoLines: true,
          overflow: Boolean(connection),
          ellipsis: true,
          fullAddress: true,
        });
    }

    await resizeInspector(720);
    await expectCompactConnection();
    await resizeInspector(360);
    await expectCompactConnection();
    await inspect("document.querySelector('#socket-picker').focus()");
    await expect
      .poll(() =>
        inspect(`getComputedStyle(
      document.querySelector('#socket-picker').parentElement
    ).outlineStyle`),
      )
      .toBe("solid");
    await inspect(
      `document.querySelectorAll('.message-row').forEach((row) => row.click())`,
      true,
    );
    await expect.poll(tabs).toHaveLength(4);
    await expect.poll(active).toBe("CALL #2");
    await expect
      .poll(() =>
        inspect(`(() => {
          const tabs = document.querySelector('#preview-tabs');
          const tab = tabs.querySelector('[aria-selected=true]').parentElement;
          const panel = document.querySelector('#message-inspector');
          const close = document.querySelector('#close-inspector');
          const closeAll = ${closeAll};
          const payload = document.querySelector('#payload-contents');
          return tabs.scrollWidth > tabs.clientWidth &&
            tab.getBoundingClientRect().right <= tabs.getBoundingClientRect().right + 1 &&
            close.getBoundingClientRect().right <= panel.getBoundingClientRect().right &&
            closeAll.getBoundingClientRect().left >= tabs.getBoundingClientRect().right &&
            closeAll.getBoundingClientRect().right <= panel.getBoundingClientRect().right &&
            payload.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1;
        })()`),
      )
      .toBe(true);
    await captureDevTools(frontend, "wamp-preview-tabs-narrow.png");

    expect(
      await inspect(`(() => {
      const list = document.querySelector('#preview-tabs');
      list.scrollLeft = 32;
      const first = list.firstElementChild;
      const source = list.lastElementChild.querySelector('[role=tab]');
      const edge = list.getBoundingClientRect().left;
      const options = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: edge + 34 };
      source.dispatchEvent(new DragEvent('dragstart', options));
      list.dispatchEvent(new DragEvent('dragover', options));
      const offset = parseFloat(getComputedStyle(first, '::before').left);
      const tabLeft = first.getBoundingClientRect().left;
      const visible = first.hasAttribute('data-drop-before') && tabLeft < edge && tabLeft + offset >= edge;
      source.dispatchEvent(new DragEvent('dragend', options));
      return visible;
    })()`),
    ).toBe(true);

    await sendCall(app, "demo.third", true);
    await openRow("demo.third");
    await expect.poll(payload).toContain("Waiting for response");
    fixture.release(3);
    await expect.poll(payload).toContain("RESULT");
    await expect.poll(active).toBe("CALL #3");

    await inspect(`${closeAll}.click()`, true);
    await expect.poll(tabs).toEqual([]);
    await expect.poll(panelVisible).toBe(false);
    await expect
      .poll(() =>
        inspect(
          "document.activeElement?.querySelector('.preview')?.textContent",
        ),
      )
      .toBe("demo.third");
    await switchConnection();
    await expect.poll(tabs).toEqual(["CALL #1"]);
    await expect.poll(payload).toContain("demo.other");
    await expectCompactConnection(longConnection);
    await captureDevTools(frontend, "wamp-compact-connection.png");
    await switchConnection();
    await expect.poll(tabs).toEqual([]);
    await openRow("demo.first");
    await expect.poll(tabs).toEqual(["CALL #1"]);

    await filterMessages("#2");
    await inspect(`${closeAll}.click()`, true);
    await expect.poll(panelVisible).toBe(false);
    await expect
      .poll(() => inspect("document.activeElement?.id"))
      .toMatch(/^(message-search|show-search)$/);
    await filterMessages("");
    await openRow("demo.first");

    await inspect("document.querySelector('#clear').click()", true);
    await expect.poll(tabs).toEqual([]);
    await switchConnection();
    await expect.poll(tabs).toEqual([]);
    await expect.poll(panelVisible).toBe(false);
  });
});

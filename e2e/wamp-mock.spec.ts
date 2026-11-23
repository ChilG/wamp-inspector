import { expect, test, type FrameLocator } from "@playwright/test";
import {
  captureDevTools,
  withInspector,
  type InspectPanel,
} from "./fixtures/wamp-inspector.js";

const selectedProcedure = "demo.success";
const selectedTopic = "score.live";
const editedBody = [["edited-fixture-result"], { wire: "mock-only" }];
const hello = [1, "fixture", { roles: { caller: {} } }];

function wireResult(id: number) {
  return [50, id, { sequence: id }, [`server-${id}`], { wire: id }];
}

function wireCall(
  id: number,
  topic = selectedTopic,
  procedure = selectedProcedure,
  mode = "result",
) {
  return [48, id, {}, procedure, [], { topic, mode }];
}

async function sendCall(
  app: FrameLocator,
  id: number,
  topic = selectedTopic,
  procedure = selectedProcedure,
  mode = "result",
) {
  await app.getByRole("textbox", { name: "Procedure" }).fill(procedure);
  await app.getByRole("textbox", { name: "Topic" }).fill(topic);
  await app.getByRole("combobox", { name: "Server reply" }).selectOption(mode);
  await app.getByRole("button", { name: "Send CALL" }).click();
  await expect(app.getByRole("status", { name: "CALL state" })).toHaveText(
    mode === "hold" ? `Waiting #${id}` : `Received #${id}`,
  );
}

function findCallRow(id: number) {
  return `[...document.querySelectorAll('[aria-controls="message-inspector"][aria-expanded]')].find(
    (button) => button.querySelector('.message-type')?.textContent === 'CALL' &&
      button.querySelector('.request-id')?.textContent === ${JSON.stringify(`#${id}`)})`;
}

async function openCallReply(
  inspect: InspectPanel,
  id: number,
  topic = selectedTopic,
) {
  const row = findCallRow(id);
  await expect
    .poll(() =>
      inspect(`(() => {
        const call = ${row};
        return call?.querySelector('.latency')?.title === 'RESULT'
          ? call.querySelector('.row-topic')?.textContent : null;
      })()`),
    )
    .toBe(topic);
  await inspect(
    `(() => {
      const call = ${row};
      if (call.getAttribute('aria-expanded') !== 'true') call.click();
    })()`,
    true,
  );
}

async function openMockEditor(
  inspect: InspectPanel,
  expectedBody: unknown[] = wireResult(1).slice(3),
  id = 1,
  topic = selectedTopic,
) {
  await openCallReply(inspect, id, topic);
  await expect
    .poll(() =>
      inspect<string>(`(() => {
        const button = document.querySelector('#mock-response-open');
        return button?.checkVisibility() && !button.disabled ? button.textContent.trim() : '';
      })()`),
    )
    .toBe("Use as mock");
  await inspect("document.querySelector('#mock-response-open').click()", true);
  await expect
    .poll(() =>
      inspect<unknown[]>(`(() => {
        const editor = document.querySelector('#mock-response-body');
        return editor?.closest('#message-inspector') && editor.checkVisibility()
          ? JSON.parse(editor.value) : null;
      })()`),
    )
    .toEqual(expectedBody);
  await expectPreview(inspect, false);
}

async function expectPreview(inspect: InspectPanel, visible: boolean) {
  await expect
    .poll(() =>
      inspect("document.querySelector('#payload-contents')?.checkVisibility()"),
    )
    .toBe(visible);
}

function findPayloadText(inspect: InspectPanel, text: string) {
  return inspect(`(() => {
    if (document.querySelector('#payload-search').hidden)
      document.querySelector('#toggle-payload-search').click();
    const query = document.querySelector('#payload-query');
    query.focus();
    query.value = ${JSON.stringify(text)};
    query.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function expectDraftMatch(
  inspect: InspectPanel,
  count: string,
  selected: string,
) {
  await expect
    .poll(() =>
      inspect(`(() => {
        const editor = document.querySelector('#mock-response-body');
        return {
          count: document.querySelector('#payload-match-count')?.textContent,
          selected: editor.value.slice(editor.selectionStart, editor.selectionEnd),
        };
      })()`),
    )
    .toEqual({ count, selected });
}

function fillMockEditor(inspect: InspectPanel, text: string) {
  return inspect(`(() => {
    const body = document.querySelector('#mock-response-body');
    body.focus();
    body.value = ${JSON.stringify(text)};
    body.setSelectionRange(body.value.length, body.value.length);
    body.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function applyMock(inspect: InspectPanel) {
  await inspect("document.querySelector('#mock-response-apply').click()", true);
  await expectPreview(inspect, true);
  await expect
    .poll(() =>
      inspect("document.querySelector('#mock-response-status')?.textContent"),
    )
    .toContain("Next matching CALL");
}

async function expectMockBadge(
  inspect: InspectPanel,
  id: number,
  label: "" | "Mock armed" | "Mocked",
  replyType = "RESULT",
) {
  await expect
    .poll(() =>
      inspect(`(() => {
        const call = ${findCallRow(id)};
        if (call?.querySelector('.latency')?.title !== ${JSON.stringify(replyType)}) return null;
        const badge = call.querySelector('.mock-badge');
        return badge?.checkVisibility() ? badge.textContent.trim() : '';
      })()`),
    )
    .toBe(label);
}

function readPreviewTree(inspect: InspectPanel, selector: string) {
  return inspect<unknown[] | null>(`(() => {
    const tree = document.querySelector(${JSON.stringify(selector)})?.querySelector('.json-tree');
    if (!tree) return null;
    for (const branch of tree.querySelectorAll('.json-branch[aria-expanded="false"]'))
      branch.click();
    return JSON.parse(tree.textContent);
  })()`);
}

function readOpenReply(inspect: InspectPanel) {
  return readPreviewTree(
    inspect,
    '#payload-contents > [data-payload="response"]',
  );
}

async function expectSavedMock(inspect: InspectPanel) {
  await expect
    .poll(() =>
      inspect(`(() => {
        const section = document.querySelector('#saved-mock-response');
        return section?.checkVisibility()
          ? section.querySelector('header')?.textContent ?? ''
          : '';
      })()`),
    )
    .toContain("Mock response");
  await expect
    .poll(() => readPreviewTree(inspect, "#saved-mock-response"))
    .toEqual(editedBody);
  await expect.poll(() => readOpenReply(inspect)).toEqual(wireResult(1));
}

async function openMockList(inspect: InspectPanel) {
  await expect
    .poll(() =>
      inspect(
        "document.querySelector('#persistent-mocks-summary')?.checkVisibility()",
      ),
    )
    .toBe(true);
  await inspect(
    `(() => {
    const details = document.querySelector('#persistent-mocks');
    if (!details.open) details.querySelector('summary').click();
  })()`,
    true,
  );
}

function mockRow(topic: string) {
  return `[...document.querySelectorAll('#persistent-mock-list > li')].find(
    (item) => item.querySelector('.persistent-mock-target').textContent.endsWith(${JSON.stringify(` · ${topic}`)}))`;
}

async function expectToggle(
  inspect: InspectPanel,
  topic: string,
  enabled: boolean,
) {
  await openMockList(inspect);
  await expect
    .poll(() =>
      inspect(`(() => {
      const item = ${mockRow(topic)};
      const button = item?.querySelector('.persistent-mock-toggle');
      return button?.checkVisibility() && button.getAttribute('aria-disabled') !== 'true'
        ? { label: button.textContent.trim(), enabled: item.hasAttribute('data-enabled') }
        : null;
    })()`),
    )
    .toEqual({ label: enabled ? "Disable mock" : "Enable mock", enabled });
}

function toggleMock(inspect: InspectPanel, topic: string) {
  return inspect(
    `(${mockRow(topic)}).querySelector('.persistent-mock-toggle').click()`,
    true,
  );
}

test("finds, saves, and reuses an edited one-shot mock in JSON preview", async () => {
  test.setTimeout(45_000);
  await withInspector(async ({ fixture, page, app, inspect, frontend }) => {
    const reply = app.getByRole("log", { name: "Reply frame" });
    await sendCall(app, 1);
    await expect(reply).toHaveText(JSON.stringify(wireResult(1)));
    await expectMockBadge(inspect, 1, "");
    await openCallReply(inspect, 1);
    await findPayloadText(inspect, "SERVER-1");
    await expect
      .poll(() =>
        inspect("document.querySelector('#payload-match-count')?.textContent"),
      )
      .toBe("1 / 1");
    await openMockEditor(inspect);
    await expectDraftMatch(inspect, "1 / 1", "server-1");
    await fillMockEditor(
      inspect,
      JSON.stringify([["server-1", "server-10"], { wire: 1 }], null, 2),
    );
    await expectDraftMatch(inspect, "1 / 2", "");
    await inspect(
      "document.querySelector('#next-payload-match').click()",
      true,
    );
    await expectDraftMatch(inspect, "2 / 2", "server-1");
    await expect
      .poll(() =>
        inspect(`(() => {
          const editor = document.querySelector('#mock-response-body');
          return editor.value.slice(editor.selectionStart, editor.selectionEnd + 1);
        })()`),
      )
      .toBe("server-10");
    await inspect(`(() => {
      const query = document.querySelector('#payload-query');
      query.focus();
      query.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
    })()`);
    await expectDraftMatch(inspect, "1 / 2", "server-1");
    await page.bringToFront();
    await captureDevTools(frontend, "wamp-mock-editor.png");
    await inspect(
      "document.querySelector('#mock-response-cancel').click()",
      true,
    );
    await expectPreview(inspect, true);
    await expectMockBadge(inspect, 1, "");
    await expect
      .poll(() =>
        inspect("document.querySelector('#mock-response-status')?.textContent"),
      )
      .not.toContain("Next matching CALL");
    await openMockEditor(inspect);
    await applyMock(inspect);
    await expectMockBadge(inspect, 1, "Mock armed");

    await sendCall(app, 2, selectedTopic, selectedProcedure, "error");
    await expect(reply).toHaveText(
      JSON.stringify([8, 48, 2, {}, "fixture.failed"]),
    );
    await expectMockBadge(inspect, 1, "");
    await expectMockBadge(inspect, 2, "", "ERROR");
    await sendCall(app, 3);
    await expect(reply).toHaveText(JSON.stringify(wireResult(3)));
    await openMockEditor(inspect);
    await fillMockEditor(inspect, "{");
    await inspect(
      "document.querySelector('#mock-response-apply').click()",
      true,
    );
    await expect
      .poll(() =>
        inspect<string>(`(() => {
          const error = document.querySelector('#mock-response-error');
          return error?.checkVisibility() ? error.textContent.trim() : '';
        })()`),
      )
      .toBeTruthy();
    await fillMockEditor(inspect, JSON.stringify(editedBody));
    await applyMock(inspect);
    await expectMockBadge(inspect, 1, "Mock armed");
    await expectSavedMock(inspect);
    await findPayloadText(inspect, "mock-only");
    await expect
      .poll(() =>
        inspect(
          "document.querySelector('#saved-mock-response mark')?.textContent",
        ),
      )
      .toBe("mock-only");
    expect(fixture.calls).toHaveLength(4);
    await inspect("document.querySelector('#expand-inspector').click()", true);
    await inspect("document.querySelector('#payload-contents').scrollTop = 0");
    await page.bringToFront();
    await captureDevTools(frontend, "wamp-mock-saved.png");
    await inspect("document.querySelector('#expand-inspector').click()", true);

    await inspect("document.querySelector('#close-inspector').click()", true);
    await expectPreview(inspect, false);
    await openMockEditor(inspect, editedBody);
    await fillMockEditor(inspect, JSON.stringify([["discarded draft"]]));
    await inspect(
      "document.querySelector('#mock-response-cancel').click()",
      true,
    );
    await expectSavedMock(inspect);

    await sendCall(app, 4, "score.pre_match");
    await expect(reply).toHaveText(JSON.stringify(wireResult(4)));
    await expectMockBadge(inspect, 4, "");
    await sendCall(app, 5, selectedTopic, "demo.other");
    await expect(reply).toHaveText(JSON.stringify(wireResult(5)));
    await expectMockBadge(inspect, 5, "");
    await expectMockBadge(inspect, 1, "Mock armed");

    await sendCall(app, 6, selectedTopic, selectedProcedure, "hold");
    await expect.poll(() => fixture?.calls.length).toBe(7);
    await expect(reply).toBeEmpty();
    await expectMockBadge(inspect, 1, "Mock armed");
    expect(fixture.replies).toHaveLength(6);
    fixture.release(6);

    const replay = [50, 6, { sequence: 6 }, ...editedBody];
    await expect(reply).toHaveText(JSON.stringify(replay));
    await expect(reply).toHaveAttribute("data-trusted", "true");
    expect(fixture.replies.at(-1)).toEqual(wireResult(6));
    await expectMockBadge(inspect, 1, "");
    await expectMockBadge(inspect, 6, "Mocked");
    await openCallReply(inspect, 6);
    await expect
      .poll(() =>
        inspect("document.querySelector('#payload-contents')?.textContent"),
      )
      .toContain("Mocked");
    await expect.poll(() => readOpenReply(inspect)).toEqual(replay);
    await page.bringToFront();
    await captureDevTools(frontend, "wamp-mock-response.png");

    await sendCall(app, 7);
    await expect(reply).toHaveText(JSON.stringify(wireResult(7)));
    await expectMockBadge(inspect, 7, "");

    await openCallReply(inspect, 1);
    await expectSavedMock(inspect);
    await openMockEditor(inspect, editedBody);
    await applyMock(inspect);
    await expectMockBadge(inspect, 1, "Mock armed");
    await sendCall(app, 8);
    await expect(reply).toHaveText(
      JSON.stringify([50, 8, { sequence: 8 }, ...editedBody]),
    );
    expect(fixture.replies.at(-1)).toEqual(wireResult(8));
    await expectMockBadge(inspect, 8, "Mocked");
    await expectMockBadge(inspect, 1, "");

    const matching = {
      procedure: selectedProcedure,
      topic: selectedTopic,
      mode: "result",
    };
    const outgoing = [
      matching,
      { ...matching, mode: "error" },
      matching,
      { ...matching, topic: "score.pre_match" },
      { ...matching, procedure: "demo.other" },
      { ...matching, mode: "hold" },
      matching,
      matching,
    ];
    expect(fixture.calls).toEqual([
      [1, "fixture", { roles: { caller: {} } }],
      ...outgoing.map(({ procedure, topic, mode }, index) => [
        48,
        index + 1,
        {},
        procedure,
        [],
        { topic, mode },
      ]),
    ]);
  });
});

for (const restart of [false, true]) {
  test(
    restart
      ? "uses an armed mock once after the extension service worker restarts"
      : "uses an armed mock once after Football changes both document URLs",
    async () => {
      test.setTimeout(45_000);
      const startupCallId = 101;
      await withInspector(
        async ({ fixture, page, app, inspect, frontend, restartWorker }) => {
          const reply = app.getByRole("log", { name: "Reply frame" });
          if (!restart) {
            await page.getByRole("button", { name: "Football" }).click();
            await expect(page).toHaveURL(/\/sport\/football$/);
            expect(fixture.connectionCount).toBe(1);
          }
          await sendCall(app, 1);
          await expect(reply).toHaveText(JSON.stringify(wireResult(1)));

          await openMockEditor(inspect);
          await fillMockEditor(inspect, JSON.stringify(editedBody));
          await applyMock(inspect);
          await expectMockBadge(inspect, 1, "Mock armed");
          expect(fixture.connectionCount).toBe(1);
          expect(fixture.calls).toHaveLength(2);

          if (restart) await restartWorker();
          await page.reload({ waitUntil: "domcontentloaded" });
          if (!restart)
            await expect(page.getByTitle("WAMP app")).toHaveAttribute(
              "src",
              "/app/football?instance=2",
            );
          const replay = [
            50,
            startupCallId,
            { sequence: startupCallId },
            ...editedBody,
          ];
          await expect(reply).toHaveText(JSON.stringify(replay));
          await expect(reply).toHaveAttribute("data-trusted", "true");
          expect(fixture.connectionCount).toBe(2);
          expect(fixture.replies.at(-1)).toEqual(wireResult(startupCallId));
          await expectMockBadge(inspect, startupCallId, "Mocked");
          await openCallReply(inspect, startupCallId);
          await expect.poll(() => readOpenReply(inspect)).toEqual(replay);
          await page.bringToFront();
          await captureDevTools(
            frontend,
            restart ? "wamp-mock-worker-restart.png" : "wamp-mock-reload.png",
          );

          if (restart) await restartWorker();
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(reply).toHaveText(
            JSON.stringify(wireResult(startupCallId)),
          );
          await expectMockBadge(inspect, startupCallId, "");
          expect(fixture.connectionCount).toBe(3);

          expect(fixture.calls).toEqual([
            hello,
            wireCall(1),
            hello,
            wireCall(startupCallId),
            hello,
            wireCall(startupCallId),
          ]);
          expect(fixture.replies.filter(([type]) => type === 50)).toEqual([
            wireResult(1),
            wireResult(startupCallId),
            wireResult(startupCallId),
          ]);
        },
        { startupCallId, rotatingFrameQuery: !restart },
      );
    },
  );
}

test("shows a mock ready after reload until a matching Topic arrives", async () => {
  test.setTimeout(45_000);
  const startupCallId = 101;
  const startupTopic = "score.pre_match";
  const matchingCallId = startupCallId + 1;
  await withInspector(
    async ({ fixture, page, app, inspect, frontend }) => {
      const reply = app.getByRole("log", { name: "Reply frame" });
      await sendCall(app, 1);
      await expect(reply).toHaveText(JSON.stringify(wireResult(1)));
      await openMockEditor(inspect);
      await fillMockEditor(inspect, JSON.stringify(editedBody));
      await applyMock(inspect);
      await expectMockBadge(inspect, 1, "Mock armed");

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(reply).toHaveText(JSON.stringify(wireResult(startupCallId)));
      expect(fixture.connectionCount).toBe(2);
      await expectMockBadge(inspect, startupCallId, "");
      await expect
        .poll(() =>
          inspect(`(() => {
            const status = document.querySelector('#pending-mock-status');
            return status?.checkVisibility() ? status.textContent : '';
          })()`),
        )
        .toEqual(
          expect.stringMatching(
            /Mock ready · Waiting for matching CALL[\s\S]*demo\.success[\s\S]*score\.live/,
          ),
        );
      expect(fixture.calls).toHaveLength(4);
      await page.bringToFront();
      await captureDevTools(frontend, "wamp-mock-pending.png");

      await sendCall(app, matchingCallId);
      const replay = [
        50,
        matchingCallId,
        { sequence: matchingCallId },
        ...editedBody,
      ];
      await expect(reply).toHaveText(JSON.stringify(replay));
      await expect(reply).toHaveAttribute("data-trusted", "true");
      await expectMockBadge(inspect, matchingCallId, "Mocked");
      await expectMockBadge(inspect, startupCallId, "");
      await expect
        .poll(() =>
          inspect(
            "Boolean(document.querySelector('#pending-mock-status')?.checkVisibility())",
          ),
        )
        .toBe(false);
      await openCallReply(inspect, matchingCallId);
      await expect.poll(() => readOpenReply(inspect)).toEqual(replay);

      expect(fixture.calls).toEqual([
        hello,
        wireCall(1),
        hello,
        wireCall(startupCallId, startupTopic),
        wireCall(matchingCallId),
      ]);
      expect(fixture.replies.filter(([type]) => type === 50)).toEqual([
        wireResult(1),
        wireResult(startupCallId),
        wireResult(matchingCallId),
      ]);
    },
    { startupCallId, startupTopic, rotatingFrameQuery: true },
  );
});

test("keeps an enabled or disabled mock across refreshes and reuses its saved JSON", async () => {
  test.setTimeout(45_000);
  const startupCallId = 101;
  const otherTopic = "score.pre_match";
  const otherProcedure = "demo.other";
  await withInspector(
    async ({ fixture, page, app, inspect, frontend, restartWorker }) => {
      const reply = app.getByRole("log", { name: "Reply frame" });

      async function expectReply(id: number, mocked: boolean) {
        const frame = mocked
          ? [50, id, { sequence: id }, ...editedBody]
          : wireResult(id);
        await expect(reply).toHaveText(JSON.stringify(frame));
        await expect(reply).toHaveAttribute("data-trusted", "true");
        await expectMockBadge(inspect, id, mocked ? "Mocked" : "");
        expect(fixture.replies.at(-1)).toEqual(wireResult(id));
      }

      async function reloadAndExpect(enabled: boolean, connections: number) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectReply(startupCallId, enabled);
        await expectToggle(inspect, selectedTopic, enabled);
        expect(fixture.connectionCount).toBe(connections);
      }

      await page.getByRole("button", { name: "Football" }).click();
      await expect(page).toHaveURL(/\/sport\/football$/);
      await sendCall(app, 1);
      await expectReply(1, false);
      await openMockEditor(inspect);
      await applyMock(inspect);
      await expectMockBadge(inspect, 1, "Mock armed");
      await openMockEditor(inspect);
      await fillMockEditor(inspect, JSON.stringify(editedBody));
      await expect
        .poll(() =>
          inspect(`(() => {
            const button = document.querySelector('#mock-response-enable');
            return button?.checkVisibility() && !button.disabled
              ? button.textContent.trim()
              : '';
          })()`),
        )
        .toBe("Enable mock");
      await inspect(
        "document.querySelector('#mock-response-enable').click()",
        true,
      );
      await expectPreview(inspect, true);
      await expectToggle(inspect, selectedTopic, true);
      await expectSavedMock(inspect);

      await sendCall(app, 2);
      await expectReply(2, true);
      await sendCall(app, 3);
      await expectReply(3, true);
      await sendCall(app, 4, otherTopic);
      await expectReply(4, false);
      await sendCall(app, 5, selectedTopic, otherProcedure);
      await expectReply(5, false);

      await reloadAndExpect(true, 2);
      await page.getByRole("button", { name: "Sports", exact: true }).click();
      await expect(page).toHaveURL(`${fixture.origin}/`);
      await restartWorker();
      await reloadAndExpect(true, 3);
      await page.bringToFront();
      await captureDevTools(frontend, "wamp-mock-enabled.png");

      const held = wireCall(102, selectedTopic, selectedProcedure, "hold");
      await sendCall(app, 102, selectedTopic, selectedProcedure, "hold");
      await expect.poll(() => fixture.calls.at(-1)).toEqual(held);
      await toggleMock(inspect, selectedTopic);
      await expectToggle(inspect, selectedTopic, false);
      fixture.release(102);
      await expectReply(102, false);

      await reloadAndExpect(false, 4);
      await page.bringToFront();
      await captureDevTools(frontend, "wamp-mock-disabled.png");
      await toggleMock(inspect, selectedTopic);
      await expectToggle(inspect, selectedTopic, true);
      await sendCall(app, 102);
      await expectReply(102, true);

      expect(fixture.calls).toEqual([
        hello,
        wireCall(1),
        wireCall(2),
        wireCall(3),
        wireCall(4, otherTopic),
        wireCall(5, selectedTopic, otherProcedure),
        hello,
        wireCall(startupCallId),
        hello,
        wireCall(startupCallId),
        held,
        hello,
        wireCall(startupCallId),
        wireCall(102),
      ]);
    },
    { startupCallId, rotatingFrameQuery: true, prependFrameOnFirstLoad: true },
  );
});

test("finds a reply from main search and manages multiple mocks independently", async () => {
  test.setTimeout(45_000);
  await withInspector(async ({ fixture, page, app, inspect }) => {
    const archivedTopic = "score.archived";
    const archivedBody = [["archived mock"], { wire: "archived" }];
    const reply = app.getByRole("log", { name: "Reply frame" });

    function search(text: string) {
      return inspect(`(() => {
        const input = document.querySelector('#message-search');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }

    async function enableMock(id: number, topic: string, body: unknown[]) {
      await openMockEditor(inspect, wireResult(id).slice(3), id, topic);
      await fillMockEditor(inspect, JSON.stringify(body));
      await inspect(
        "document.querySelector('#mock-response-enable').click()",
        true,
      );
      await expectPreview(inspect, true);
      await expectToggle(inspect, topic, true);
    }

    async function expectBody(id: number, body: unknown[]) {
      await expect(reply).toHaveText(
        JSON.stringify([50, id, { sequence: id }, ...body]),
      );
    }

    async function deleteMock(topic: string) {
      const button = `(${mockRow(topic)})?.querySelector('.persistent-mock-delete')`;
      await expect
        .poll(() => inspect(`${button}?.checkVisibility() ?? false`))
        .toBe(true);
      await inspect(
        `(() => {
        const action = ${button};
        action.focus();
        action.click();
      })()`,
        true,
      );
      await expect
        .poll(() => inspect(`Boolean(${mockRow(topic)})`))
        .toBe(false);
      await expect
        .poll(() => inspect("document.activeElement?.id"))
        .toMatch(/^(persistent-mocks-summary|message-search|show-search)$/);
    }

    await sendCall(app, 1);
    await sendCall(app, 2, archivedTopic);
    await expectMockBadge(inspect, 2, "");
    await search('"wire":2');
    await expect
      .poll(() =>
        inspect(`([...document.querySelectorAll('[aria-controls="message-inspector"][aria-expanded]')]
        .filter((button) => button.checkVisibility())
        .map((button) => button.querySelector('.request-id')?.textContent))`),
      )
      .toEqual(["#2"]);
    await enableMock(2, archivedTopic, archivedBody);
    await search("");
    await enableMock(1, selectedTopic, editedBody);
    await expect
      .poll(() =>
        inspect(
          "document.querySelector('#persistent-mocks-count').textContent",
        ),
      )
      .toBe("Mocks (2)");
    await expectToggle(inspect, archivedTopic, true);

    await sendCall(app, 3, archivedTopic);
    await expectBody(3, archivedBody);
    await sendCall(app, 4);
    await expectBody(4, editedBody);

    await toggleMock(inspect, archivedTopic);
    await expectToggle(inspect, archivedTopic, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectToggle(inspect, archivedTopic, false);
    await expectToggle(inspect, selectedTopic, true);
    await sendCall(app, 1, archivedTopic);
    await expectBody(1, wireResult(1).slice(3));
    await sendCall(app, 2);
    await expectBody(2, editedBody);
    await toggleMock(inspect, archivedTopic);
    await expectToggle(inspect, archivedTopic, true);
    await sendCall(app, 3, archivedTopic);
    await expectBody(3, archivedBody);

    await sendCall(app, 4, archivedTopic, selectedProcedure, "hold");
    await expect
      .poll(() => fixture.calls.at(-1))
      .toEqual(wireCall(4, archivedTopic, selectedProcedure, "hold"));
    await deleteMock(archivedTopic);
    await expectToggle(inspect, selectedTopic, true);
    fixture.release(4);
    await expectBody(4, wireResult(4).slice(3));

    await page.reload({ waitUntil: "domcontentloaded" });
    await expectToggle(inspect, selectedTopic, true);
    await expect
      .poll(() => inspect(`Boolean(${mockRow(archivedTopic)})`))
      .toBe(false);
    await sendCall(app, 1, archivedTopic);
    await expectBody(1, wireResult(1).slice(3));
    await sendCall(app, 2);
    await expectBody(2, editedBody);

    await toggleMock(inspect, selectedTopic);
    await expectToggle(inspect, selectedTopic, false);
    await deleteMock(selectedTopic);
    await expect
      .poll(() => inspect("document.querySelector('#persistent-mocks').hidden"))
      .toBe(true);
  });
});

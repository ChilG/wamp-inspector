# WAMP Inspector

A Chrome DevTools extension for inspecting WAMP traffic over WebSocket. It shows connections, messages, request/response pairs, and their JSON payloads in a compact panel.

![WAMP Inspector showing captured messages and a JSON payload in Chrome DevTools](docs/images/devtools.png)

## Load in Chrome

1. Clone or download this repository and extract it if needed.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Open a page that uses WAMP. Open Chrome DevTools and select **WAMP Inspector** from the tab bar or the `»` overflow menu.
5. Reload the inspected page to capture connections from the start.

The extension runs directly from the repository with no build step. After editing the source, reload the extension in `chrome://extensions`, refresh the inspected page, and reopen DevTools.

## Inspect traffic

- Select an open or closed connection to view its capture. The toolbar popup summarizes WAMP activity on the current tab.
- Search by topic, procedure, or request ID. Use **Filters** to narrow by message type, response status, or latency, or to search across JSON payloads.
- Select a message to inspect its payload. Use **Find** in JSON Preview to search keys and values within the selected Request and Response, including collapsed branches.
- Enable **Topic** from **Columns**, or click a key in JSON Preview to add that field as a custom column. Drag a column divider to resize it.
- Use **Clear messages** to clear the current tab’s message history and keep its connection list. The extension retains the latest 1,000 frames per recognized WAMP type per connection.

## Send mock calls from DevTools

1. Run `npm ci` with Node.js 22 or newer, then run `npm run mock:wamp`.
2. Open `http://127.0.0.1:8765` in Chrome and select **WAMP Inspector** in DevTools. Reload the page if you want to capture the WebSocket handshake.
3. Click **Send mock**, choose a scenario, and click **Send CALL**. Select the captured row to inspect the request and response.

| Scenario        | Result                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Success**     | The router returns `RESULT` for the demo call.                                                                 |
| **Error**       | The router returns `ERROR` for the demo call.                                                                  |
| **No response** | The page reports a timeout after two seconds. The connection stays open and the captured call remains pending. |

The DevTools control sends the selected mock through the demo's `wamp.2.json` WebSocket on loopback. The demo page also has a **Send CALL** control that uses the same connection.

## Project layout

```text
manifest.json       Chrome extension entry points and permissions
icons/              Extension and DevTools icons
src/capture/        WebSocket hook, page bridge, and background storage
src/devtools/       DevTools panel, message filters, and JSON preview
src/popup/          Toolbar popup and current-tab summary
src/shared/         WAMP frame parsing and theme styles
tools/              Local mock WAMP router and demo page
tests/              Node tests for the extension and local tools
e2e/                Chrome end-to-end tests
docs/images/        Screenshots captured with local test traffic
```

## Run the tests

Run `npm test` from the repository root with Node.js 22 or newer. Install dependencies with `npm ci` first. The tests use Node’s built-in test runner and local loopback connections.

Run `npm run typecheck` to check the capture worker, WAMP frame parser, and DevTools capture transport against the shared TypeScript contracts. The browser continues to run JavaScript from the repository directly.

Run `npm run format` to apply Prettier and `npm run format:check` to check formatting.

With Google Chrome installed, run `npm run test:e2e` to verify sending mock calls from the Inspector in a temporary browser profile.

## Package a release

Run **Package WAMP Inspector** from the repository's **Actions** tab to download the extension ZIP as a workflow artifact. The workflow must be on the default branch before you can run it manually.

For a GitHub release, push a tag that matches the version in `manifest.json`, such as `v0.1.0`. After checks pass, the workflow attaches `wamp-inspector-0.1.0.zip` to a draft on the **Releases** page. Review the draft and publish it when ready.

The ZIP contains `manifest.json` at its root, along with the runtime files and icons. The same ZIP format is used for Chrome Web Store submissions.

## Data and permissions

The extension injects a WebSocket hook into supported pages and frames so it can observe WAMP traffic created by the page. It keeps captured traffic in memory in the extension’s service worker. Column preferences are stored locally and do not include payload contents.

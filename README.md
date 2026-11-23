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

## Share live metadata with Codex

This integration uses Google Chrome on macOS, Codex CLI, and Node.js 22 or newer.

1. Run `npm ci` from the repo. Load the unpacked extension and copy its ID from `chrome://extensions`.
2. Register the Chrome Native Messaging host and add the local MCP server to Codex. Use the Node.js 22+ binary on your `PATH`.

   ```sh
   npm run mcp:install -- YOUR_EXTENSION_ID
   codex mcp add wamp-inspector -- "$(command -v node)" "$PWD/tools/mcp/server.js"
   ```

3. Restart Codex. In Chrome, open WAMP Inspector in the tab's DevTools, select **Share with MCP**, and grant Native Messaging access if asked.
4. Ask Codex to list WAMP connections and inspect a connection, for example, “Which CALLs are still pending?” Codex reads the current capture when it calls a tool.

Only one tab can share at a time. **Stop sharing**, closing the tab or DevTools, or reloading the page ends access. The tools inspect WAMP JSON frames and return metadata such as procedure, topic, status, and latency. Payloads, URLs, and authentication fields stay in Chrome. Data already returned to Codex can remain in the Codex session.

If the panel cannot find the host, check that the installed Chrome extension ID matches the one passed to the installer and that the checkout has not moved. Run `npm run mcp:uninstall` to remove the Chrome host registration and `codex mcp remove wamp-inspector` to remove the Codex configuration.

## Test with the local mock router

Run `npm run mock:wamp` and open `http://127.0.0.1:8765` in Chrome. Open WAMP Inspector and reload the page to capture the connection from its start. Select a scenario and press **Send CALL**.

| Scenario        | Result                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| **Success**     | The router returns `RESULT` for the demo call.                                                                 |
| **Error**       | The router returns `ERROR` for the demo call.                                                                  |
| **No response** | The page reports a timeout after two seconds. The connection stays open and the captured call remains pending. |

The router speaks `wamp.2.json` and serves the demo on loopback. It sends synthetic responses to the demo page.

## Project layout

```text
manifest.json       Chrome extension entry points and permissions
icons/              Extension and DevTools icons
src/capture/        WebSocket hook, page bridge, and background storage
src/devtools/       DevTools panel, message filters, and JSON preview
src/popup/          Toolbar popup and current-tab summary
src/shared/         WAMP frame parsing and theme styles
tools/              Local MCP companion and mock WAMP router
tests/              Node tests for the extension and local tools
e2e/                Chrome end-to-end tests
docs/images/        Screenshots captured with local test traffic
```

## Run the tests

Run `npm test` from the repository root with Node.js 22 or newer. Install dependencies with `npm ci` first. The tests use Node’s built-in test runner and local loopback connections.

Run `npm run typecheck` to check the capture worker, WAMP frame parser, and DevTools capture transport against the shared TypeScript contracts. The browser continues to run JavaScript from the repository directly.

Run `npm run format` to apply Prettier and `npm run format:check` to check formatting.

On macOS with Google Chrome installed, run `npm run test:e2e` to verify the demo and the Chrome-to-MCP flow in a temporary profile. Set `WAMP_INSPECTOR_E2E_CODEX=1` to exercise the tools through an installed Codex CLI. The suite pregrants Native Messaging in a disposable extension copy for unattended runs. Set `WAMP_INSPECTOR_E2E_PROMPT=1` to test the permission prompt interactively with the original manifest.

## Package a release

Run **Package WAMP Inspector** from the repository's **Actions** tab to download the extension ZIP as a workflow artifact. The workflow must be on the default branch before you can run it manually.

For a GitHub release, push a tag that matches the version in `manifest.json`, such as `v0.1.0`. After checks pass, the workflow attaches `wamp-inspector-0.1.0.zip` to a draft on the **Releases** page. Review the draft and publish it when ready.

The ZIP contains `manifest.json` at its root, along with the runtime files and icons. The same ZIP format is used for Chrome Web Store submissions.

## Data and permissions

The extension injects a WebSocket hook into supported pages and frames so it can observe WAMP traffic created by the page. It keeps captured traffic in memory in the extension’s service worker. Column preferences are stored locally and do not include payload contents.

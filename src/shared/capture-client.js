/**
 * @template {import("./capture-contracts.js").CaptureRequest} Request
 * @param {Request} message
 * @returns {Promise<import("./capture-contracts.js").CaptureResponses[Request["type"]]>}
 */
export function sendCaptureRequest(message) {
  return chrome.runtime.sendMessage(message);
}

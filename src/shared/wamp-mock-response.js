/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
export function isMockProcedure(value) {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
}

/** @param {unknown} value @returns {value is string | null} */
export function isMockTopic(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 512)
  );
}

/** @param {unknown} value */
function isRequestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown[]} frame @param {number} argsIndex */
function hasValidArguments(frame, argsIndex) {
  return (
    frame.length <= argsIndex + 2 &&
    (frame.length <= argsIndex || Array.isArray(frame[argsIndex])) &&
    (frame.length <= argsIndex + 1 || isObject(frame[argsIndex + 1]))
  );
}

/** @param {unknown} value @returns {value is unknown[] | null} */
export function isMockResponse(value) {
  if (value === null) return true;
  if (!Array.isArray(value)) return false;
  if (value[0] === 50) {
    const [, requestId, details] = value;
    return (
      isRequestId(requestId) &&
      isObject(details) &&
      (details.progress === undefined || details.progress === false) &&
      hasValidArguments(value, 3)
    );
  }
  if (value[0] === 8) {
    const [, requestType, requestId, details, errorUri] = value;
    return (
      requestType === 48 &&
      isRequestId(requestId) &&
      isObject(details) &&
      typeof errorUri === "string" &&
      errorUri.trim().length > 0 &&
      hasValidArguments(value, 5)
    );
  }
  return false;
}

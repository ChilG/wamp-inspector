import { readWampFrame } from "../shared/wamp-frame.js";

/** @typedef {import("../shared/capture-contracts.js").CapturedFrame} CapturedFrame */

const MAX_FRAMES_PER_TYPE = 1000;
const MAX_SAVED_MOCKS = 64;
const MAX_SAVED_MOCK_CHARACTERS = 4 * 1_048_576;
/** @type {WeakMap<FrameHistory, Map<string, Set<symbol>>>} */
const pendingMockSaves = new WeakMap();

export class FrameHistory {
  /** @type {Map<number, CapturedFrame>} */
  #frames = new Map();
  /** @type {Map<string, {ids: number[], writeIndex: number}>} */
  #buckets = new Map();
  #nextId = 0;

  /** @param {CapturedFrame} frame */
  add(frame) {
    const type = readWampFrame(frame).knownType ?? "UNKNOWN";
    let bucket = this.#buckets.get(type);
    if (!bucket) {
      bucket = { ids: [], writeIndex: 0 };
      this.#buckets.set(type, bucket);
    }

    const id = this.#nextId++;
    // Each type cycles through its slots while the map retains capture order across types.
    const evictedId = bucket.ids[bucket.writeIndex];
    if (evictedId !== undefined) this.#frames.delete(evictedId);
    bucket.ids[bucket.writeIndex] = id;
    bucket.writeIndex = (bucket.writeIndex + 1) % MAX_FRAMES_PER_TYPE;
    this.#frames.set(id, frame);
  }

  get size() {
    return this.#frames.size;
  }

  toArray() {
    return Array.from(this.#frames.values());
  }
}

/** @param {FrameHistory} history @param {string} sourceKey */
export function beginMockSave(history, sourceKey) {
  const pending = pendingMockSaves.get(history) ?? new Map();
  pendingMockSaves.set(history, pending);
  const attempts = pending.get(sourceKey) ?? new Set();
  pending.set(sourceKey, attempts);
  const attempt = Symbol();
  attempts.add(attempt);

  /** @param {boolean} accepted */
  return (accepted) => {
    if (!attempts.has(attempt)) return false;
    if (accepted) {
      // A later accepted apply supersedes earlier acknowledgements for this source.
      for (const earlier of attempts) {
        attempts.delete(earlier);
        if (earlier === attempt) break;
      }
    } else {
      attempts.delete(attempt);
    }
    if (!attempts.size) pending.delete(sourceKey);
    if (!pending.size) pendingMockSaves.delete(history);
    return accepted;
  };
}

/** @template {{savedMocks: Map<string, string | null>}} SocketRecord @param {SocketRecord} socket @param {string} sourceKey @param {string | null} resultBody */
export function withSavedMock(socket, sourceKey, resultBody) {
  const savedMocks = new Map(socket.savedMocks);
  savedMocks.delete(sourceKey);
  savedMocks.set(sourceKey, resultBody);
  let characters = 0;
  for (const body of savedMocks.values()) characters += body?.length ?? 0;
  for (const [oldest, body] of savedMocks) {
    if (
      savedMocks.size <= MAX_SAVED_MOCKS &&
      characters <= MAX_SAVED_MOCK_CHARACTERS
    )
      break;
    characters -= body?.length ?? 0;
    savedMocks.delete(oldest);
  }
  return { ...socket, savedMocks };
}

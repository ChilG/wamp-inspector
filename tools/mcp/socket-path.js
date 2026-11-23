import { once } from "node:events";
import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BridgeError } from "./protocol.js";

export function getSocketPath() {
  return (
    process.env.WAMP_INSPECTOR_SOCKET ||
    join(homedir(), ".wamp-inspector", "bridge.sock")
  );
}

export async function checkSocketDirectory(socketPath, create = false) {
  const directory = dirname(socketPath);
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) {
    throw new BridgeError(
      "UNSAFE_SOCKET_PATH",
      "The bridge needs an absolute Unix socket path within 103 bytes.",
    );
  }
  if (create) {
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new BridgeError(
      "UNSAFE_SOCKET_PATH",
      "The bridge socket directory must be owned by your account and have mode 0700.",
    );
  }
}

export async function checkSocketFile(socketPath) {
  const stat = await lstat(socketPath);
  if (
    !stat.isSocket() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new BridgeError(
      "UNSAFE_SOCKET_PATH",
      "The bridge socket must be owned by your account and have mode 0600.",
    );
  }
}

function listen(server, socketPath) {
  const ready = once(server, "listening");
  server.listen(socketPath);
  return ready;
}

async function removeStaleSocket(socketPath) {
  await checkSocketFile(socketPath);
  const probe = createConnection({ path: socketPath });
  try {
    await once(probe, "connect");
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
    await unlink(socketPath);
    return;
  } finally {
    probe.destroy();
  }
  throw sharingBusy();
}

function sharingBusy() {
  return new BridgeError(
    "SHARING_BUSY",
    "Another Chrome window is already sharing with MCP. Stop sharing there or try again.",
  );
}

async function acquireRecoveryLock(path) {
  const owner = String(process.pid);
  try {
    await symlink(owner, path);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const previous = await readlink(path);
  if (!/^[1-9]\d{0,9}$/.test(previous)) throw sharingBusy();
  try {
    process.kill(Number(previous), 0);
    throw sharingBusy();
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if ((await readlink(path)) !== previous) throw sharingBusy();
  await unlink(path);
  await symlink(owner, path);
}

export async function listenOnPrivateSocket(server, socketPath) {
  await checkSocketDirectory(socketPath, true);
  try {
    await listen(server, socketPath);
    return;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }

  const recovery = `${socketPath}.recovery`;
  await acquireRecoveryLock(recovery);
  try {
    await removeStaleSocket(socketPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await listen(server, socketPath);
  } finally {
    if ((await readlink(recovery)) === String(process.pid))
      await unlink(recovery);
  }
}

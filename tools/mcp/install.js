import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeHostName } from "./protocol.js";
import { getSocketPath } from "./socket-path.js";

const extensionIdPattern = /^[a-p]{32}$/;
const launcherHeader = "#!/bin/sh\n# Managed by WAMP Inspector\n";
const description = "WAMP Inspector read-only MCP bridge";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function installationPaths() {
  const userDataDir =
    process.env.WAMP_INSPECTOR_CHROME_DATA_DIR ||
    join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (!isAbsolute(userDataDir))
    throw new Error("Chrome user data directory must be an absolute path.");
  const directory = join(userDataDir, "NativeMessagingHosts");
  return {
    directory,
    manifest: join(directory, `${nativeHostName}.json`),
    launcher: join(directory, `${nativeHostName}.sh`),
  };
}

async function asExisting(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid()) {
      throw new Error(`Refusing to change an existing file at ${path}.`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function validateExisting(paths) {
  const info = await lstat(paths.directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Chrome's NativeMessagingHosts directory must be writable only by your account.",
    );
  }
  const [manifest, launcher] = await Promise.all([
    asExisting(paths.manifest),
    asExisting(paths.launcher),
  ]);
  if (manifest !== null) {
    const parsed = JSON.parse(manifest);
    if (
      parsed?.name !== nativeHostName ||
      parsed?.description !== description ||
      parsed?.path !== paths.launcher
    ) {
      throw new Error(
        `Refusing to change an existing native host at ${paths.manifest}.`,
      );
    }
  }
  if (launcher !== null && !launcher.startsWith(launcherHeader)) {
    throw new Error(
      `Refusing to change an existing launcher at ${paths.launcher}.`,
    );
  }
  return { manifest, launcher };
}

async function install(paths, extensionId) {
  const socketPath = getSocketPath();
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) {
    throw new Error(
      "The bridge needs an absolute Unix socket path within 103 bytes.",
    );
  }
  const nativeScript = fileURLToPath(
    new URL("./native-host.js", import.meta.url),
  );
  const launcher = `${launcherHeader}export WAMP_INSPECTOR_SOCKET=${shellQuote(socketPath)}\nexec ${shellQuote(process.execPath)} ${shellQuote(nativeScript)} "$@"\n`;
  const manifest = {
    name: nativeHostName,
    description,
    path: paths.launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  await mkdir(paths.directory, { mode: 0o700, recursive: true });
  await validateExisting(paths);
  const staging = await mkdtemp(join(paths.directory, ".wamp-inspector-"));
  const stagedLauncher = join(staging, "launcher.sh");
  const stagedManifest = join(staging, "manifest.json");
  try {
    await writeFile(stagedLauncher, launcher, { mode: 0o700, flag: "wx" });
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(stagedLauncher, paths.launcher);
    await rename(stagedManifest, paths.manifest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`Installed Chrome native host at ${paths.manifest}`);
}

async function uninstall(paths) {
  const existing = await validateExisting(paths).catch((error) => {
    if (error.code === "ENOENT") return { manifest: null, launcher: null };
    throw error;
  });
  if (existing.manifest !== null) await unlink(paths.manifest);
  if (existing.launcher !== null) await unlink(paths.launcher);
  console.log("Unregistered the WAMP Inspector Chrome native host.");
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("This installer supports Google Chrome on macOS.");
  const [argument, ...extra] = process.argv.slice(2);
  const paths = installationPaths();
  if (extra.length > 0)
    throw new Error("Pass one Chrome extension ID or --uninstall.");
  if (argument === "--uninstall") return uninstall(paths);
  if (!extensionIdPattern.test(argument ?? "")) {
    throw new Error(
      "Provide the 32-character extension ID shown at chrome://extensions.",
    );
  }
  return install(paths, argument);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

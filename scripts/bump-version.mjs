import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";

const bumpTypes = ["major", "minor", "patch"];
const maxComponent = 65535;
const stableVersion = /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2}$/;

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${filename}. ${error.message}`);
  }
}

function nextVersion(current, bumpIndex) {
  const versionError =
    "Expected a stable Chrome extension version with three components between 0 and 65535.";
  if (typeof current !== "string" || !stableVersion.test(current))
    throw new Error(versionError);

  const components = current.split(".").map(Number);
  if (
    components.some((part) => part > maxComponent) ||
    components.every((part) => part === 0)
  ) {
    throw new Error(versionError);
  }
  if (components[bumpIndex] === maxComponent) {
    throw new Error(
      "Bump would exceed the Chrome extension version limit of 65535.",
    );
  }

  return components
    .map((part, index) => {
      if (index < bumpIndex) return part;
      return index === bumpIndex ? part + 1 : 0;
    })
    .join(".");
}

async function bump(args) {
  const bumpIndex = bumpTypes.indexOf(args[0]);
  if (args.length !== 1 || bumpIndex === -1)
    throw new Error("Usage: node scripts/bump-version.mjs patch|minor|major");

  const [manifest, pkg, lock] = await Promise.all([
    readJson("manifest.json"),
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);
  const version = nextVersion(manifest?.version, bumpIndex);
  const current = manifest.version;
  if (
    [pkg?.version, lock?.version, lock?.packages?.[""]?.version].some(
      (value) => value !== current,
    )
  ) {
    throw new Error(
      "The manifest, package, and package-lock versions must match before the bump.",
    );
  }

  const updates = {
    "manifest.json": { ...manifest, version },
    "package.json": { ...pkg, version },
    "package-lock.json": {
      ...lock,
      version,
      packages: { ...lock.packages, "": { ...lock.packages[""], version } },
    },
  };
  const formatted = await Promise.all(
    Object.entries(updates).map(async ([filepath, data]) => [
      filepath,
      await format(JSON.stringify(data, null, 2), { filepath }),
    ]),
  );
  for (const [filepath, content] of formatted)
    await writeFile(filepath, content);
  console.log(version);
}

try {
  await bump(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

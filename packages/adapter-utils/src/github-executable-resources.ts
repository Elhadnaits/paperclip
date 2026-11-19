import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { posix } from "node:path";

const { basename, dirname, isAbsolute, join, normalize, resolve } = posix;

type FileIdentity = Readonly<{
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
}>;

/** Controller-owned admission receipt. All paths refer to the same selected toolchain. */
export type InstalledGitSelection = Readonly<{
  executable: string;
  executableIdentity: FileIdentity;
  executableDigest: string;
  gitExecPath: string;
  gitTemplateDir: string;
  readOnlyRoots: readonly [string, string, string];
  selectionDigest: string;
}>;

const selectionError = "native_github_apple_git_selection_invalid";
const discoveryTimeoutMs = 8_000;
const maxResourceEntries = 1_024;
const maxExecutableSize = 32n * 1024n * 1024n;
const requiredHelpers = ["git-remote-http", "git-remote-https", "git-upload-pack"] as const;

function fileIdentity(stat: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  });
}

function trustedMode(stat: BigIntStats): boolean {
  return stat.uid === 0n && (stat.mode & 0o022n) === 0n;
}

async function trustedDirectory(path: string): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || !trustedMode(stat)) throw new Error(selectionError);
  return stat;
}

function toolPath(output: string): string {
  const path = output.replace(/\r?\n$/, "");
  if (path !== path.trim() || /[\x00-\x1f\x7f]/u.test(path)
    || !isAbsolute(path) || path === "/" || normalize(path) !== path || path.endsWith("/")) {
    throw new Error(selectionError);
  }
  return path;
}

function selectedPath(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((fulfill, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 2_000,
      signal,
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
    }, (error, stdout) => {
      if (error) reject(error);
      else fulfill(stdout);
    });
  });
}

async function validateAncestry(path: string, signal: AbortSignal): Promise<void> {
  // Walk from the filesystem root so a rejected ancestor is never traversed.
  const parents: string[] = [];
  for (let parent = path; parent !== "/"; parent = dirname(parent)) parents.push(parent);
  parents.push("/");
  for (const parent of parents.reverse()) {
    signal.throwIfAborted();
    await trustedDirectory(parent);
  }
}

async function hashExecutable(path: string): Promise<{ identity: FileIdentity; digest: string }> {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await descriptor.stat({ bigint: true });
    if (!stat.isFile() || !trustedMode(stat) || (stat.mode & 0o001n) === 0n
      || stat.size <= 0n || stat.size > maxExecutableSize) throw new Error(selectionError);
    const identity = fileIdentity(stat);
    const bytes = await descriptor.readFile();
    const [after, named] = await Promise.all([descriptor.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (BigInt(bytes.length) !== stat.size || !trustedMode(after) || !named.isFile() || !trustedMode(named)
      || after.mode !== stat.mode || named.mode !== stat.mode
      || JSON.stringify(fileIdentity(after)) !== JSON.stringify(identity)
      || JSON.stringify(fileIdentity(named)) !== JSON.stringify(identity)) throw new Error(selectionError);
    return { identity, digest: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await descriptor.close();
  }
}

function withinNamedResources(path: string, root: string, executable: string): boolean {
  return path === executable || path.startsWith(`${root}/`);
}

async function manifest(root: string, executable: string, helpers: boolean, signal: AbortSignal): Promise<string> {
  const paths = [root];
  const digest = createHash("sha256");
  let remaining = maxResourceEntries;
  while (paths.length > 0) {
    const path = paths.pop()!;
    signal.throwIfAborted();
    const stat = await lstat(path, { bigint: true });
    let link: string | null = null;
    if (stat.isSymbolicLink()) {
      link = await readlink(path);
      const target = resolve(dirname(path), link);
      // These stock CLT entries point outside the granted resources. Record
      // their link text without following them or adding their targets.
      const stockAlias = helpers && dirname(path) === root
        && ["git-shell", "scalar"].includes(basename(path))
        && link === `../../bin/${basename(path)}`;
      if (stat.uid !== 0n || (!stockAlias && (!withinNamedResources(target, root, executable)
        || !withinNamedResources(await realpath(path), root, executable)))) {
        throw new Error(selectionError);
      }
    } else if (!trustedMode(stat) || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(selectionError);
    }
    digest.update(JSON.stringify([path, fileIdentity(stat), String(stat.mode), link]));
    if (stat.isDirectory()) {
      const children = (await readdir(path)).sort().reverse();
      if (children.length + paths.length > maxResourceEntries) throw new Error(selectionError);
      paths.push(...children.map((name) => join(path, name)));
    }
    // Limit total traversal even when the tree is deep and narrow.
    if (--remaining === 0 && paths.length > 0) throw new Error(selectionError);
  }
  return digest.digest("hex");
}

/** Call only in the trusted local macOS controller, before admitting managed Git. */
export async function discoverInstalledAppleGit(): Promise<InstalledGitSelection> {
  const signal = AbortSignal.timeout(discoveryTimeoutMs);
  try {
    const [developerOutput, executableOutput] = await Promise.all([
      selectedPath("/usr/bin/xcode-select", ["--print-path"], signal),
      selectedPath("/usr/bin/xcrun", ["--no-cache", "--find", "git"], signal),
    ]);
    const developerRoot = toolPath(developerOutput);
    const executable = toolPath(executableOutput);
    const usr = join(developerRoot, "usr");
    if (executable !== join(usr, "bin", "git")) throw new Error(selectionError);
    const gitExecPath = join(usr, "libexec", "git-core");
    const gitTemplateDir = join(usr, "share", "git-core", "templates");
    await Promise.all([dirname(executable), gitExecPath, gitTemplateDir].map((path) => validateAncestry(path, signal)));
    if (await realpath(executable) !== executable) throw new Error(selectionError);
    for (const name of requiredHelpers) {
      const path = await realpath(join(gitExecPath, name));
      if (!withinNamedResources(path, gitExecPath, executable)) throw new Error(selectionError);
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || !trustedMode(stat) || (stat.mode & 0o001n) === 0n) throw new Error(selectionError);
    }
    const [binary, helperDigest, templateDigest, developer] = await Promise.all([
      hashExecutable(executable),
      manifest(gitExecPath, executable, true, signal),
      manifest(gitTemplateDir, executable, false, signal),
      trustedDirectory(developerRoot),
    ]);
    signal.throwIfAborted();
    const selectionDigest = createHash("sha256").update(JSON.stringify([
      developerRoot, fileIdentity(developer), executable, binary.identity, binary.digest,
      gitExecPath, helperDigest, gitTemplateDir, templateDigest,
    ])).digest("hex");
    return Object.freeze({
      executable, executableIdentity: binary.identity, executableDigest: binary.digest,
      gitExecPath, gitTemplateDir, readOnlyRoots: Object.freeze([executable, gitExecPath, gitTemplateDir] as const),
      selectionDigest,
    });
  } catch {
    // Do not surface subprocess stderr or allow a failed admission to fall back to PATH.
    throw new Error(selectionError);
  }
}

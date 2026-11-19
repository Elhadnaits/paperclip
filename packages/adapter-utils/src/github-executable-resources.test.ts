import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverInstalledAppleGit } from "./github-executable-resources.js";

const mock = vi.hoisted(() => ({
  root: "",
  developerOutput: "",
  executableOutput: "",
  osFailure: false,
  wrongOwner: "",
  calls: [] as Array<[string, string[], object]>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (!mock.root) return actual.execFile(file, args, options, callback);
      mock.calls.push([file, args, options]);
      queueMicrotask(() => callback?.(
        mock.osFailure ? Object.assign(new Error("fixture subprocess timeout"), { killed: true }) : null,
        file === "/usr/bin/xcode-select" ? mock.developerOutput : mock.executableOutput,
        "",
      ));
      return new actual.ChildProcess();
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string, options: { bigint: true }) => {
      const stat = await actual.lstat(path, options);
      if (mock.root) {
        stat.uid = path === mock.wrongOwner ? 501n : 0n;
        // The fixture's ancestors include the OS temporary directory. Simulate
        // the trusted toolchain ancestry without changing real permissions.
        if (path !== mock.root && mock.root.startsWith(path === "/" ? "/" : `${path}/`)) stat.mode &= ~0o022n;
      }
      return stat;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const descriptor = await actual.open(...args);
      if (!mock.root) return descriptor;
      const stat = descriptor.stat.bind(descriptor);
      return Object.assign(descriptor, {
        async stat(options: { bigint: true }) {
          return Object.assign(await stat(options), { uid: args[0] === mock.wrongOwner ? 501n : 0n });
        },
      });
    },
  };
});

const selectionError = "native_github_apple_git_selection_invalid";
const gitBytes = "fixture Apple Git bytes";

async function toolchain() {
  mock.root = await realpath(await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "apple-git-")));
  const developer = join(mock.root, "Test Xcode.app", "Contents", "Developer");
  const executable = join(developer, "usr", "bin", "git");
  const helpers = join(developer, "usr", "libexec", "git-core");
  const templates = join(developer, "usr", "share", "git-core", "templates");
  await Promise.all([dirname(executable), helpers, templates].map((path) => mkdir(path, { recursive: true })));
  await writeFile(executable, gitBytes, { mode: 0o755 });
  await writeFile(join(helpers, "git-remote-http"), "fixture helper", { mode: 0o755 });
  await symlink("git-remote-http", join(helpers, "git-remote-https"));
  await symlink("../../bin/git", join(helpers, "git-upload-pack"));
  await symlink("../../bin/git-shell", join(helpers, "git-shell"));
  await symlink("../../bin/scalar", join(helpers, "scalar"));
  await writeFile(join(templates, "description"), "fixture template");
  mock.developerOutput = `${developer}\n`;
  mock.executableOutput = `${executable}\n`;
  return { developer, executable, helpers, templates };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  const root = mock.root;
  Object.assign(mock, { root: "", developerOutput: "", executableOutput: "", osFailure: false, wrongOwner: "", calls: [] });
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("controller-selected Apple Git", () => {
  it("pins one immutable receipt and only the three named read roots", async () => {
    const fixture = await toolchain();
    vi.stubEnv("DEVELOPER_DIR", "/untrusted-toolchain");
    vi.stubEnv("GIT_EXEC_PATH", "/untrusted-helpers");
    vi.stubEnv("GIT_TEMPLATE_DIR", "/untrusted-templates");
    vi.stubEnv("PATH", "/untrusted-bin");
    const selection = await discoverInstalledAppleGit();
    expect(selection).toMatchObject({
      executable: fixture.executable,
      executableDigest: createHash("sha256").update(gitBytes).digest("hex"),
      gitExecPath: fixture.helpers,
      gitTemplateDir: fixture.templates,
      readOnlyRoots: [fixture.executable, fixture.helpers, fixture.templates],
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.executableIdentity)).toBe(true);
    expect(Object.isFrozen(selection.readOnlyRoots)).toBe(true);
    expect((await discoverInstalledAppleGit()).selectionDigest).toBe(selection.selectionDigest);
    expect(mock.calls.slice(0, 2)).toMatchObject([
      ["/usr/bin/xcode-select", ["--print-path"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2_000 }],
      ["/usr/bin/xcrun", ["--no-cache", "--find", "git"], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2_000 }],
    ]);
    for (const [, , options] of mock.calls) expect(options).toHaveProperty("env", { PATH: "/usr/bin:/bin", LC_ALL: "C" });
  });

  it("changes the receipt when an installed binary or named resource changes", async () => {
    const { executable, templates } = await toolchain();
    const original = await discoverInstalledAppleGit();
    await writeFile(join(templates, "description"), "changed template contents");
    const templateChanged = await discoverInstalledAppleGit();
    expect(templateChanged.selectionDigest).not.toBe(original.selectionDigest);
    expect(templateChanged.executableDigest).toBe(original.executableDigest);
    await writeFile(executable, "new installed Apple Git bytes");
    const binaryChanged = await discoverInstalledAppleGit();
    expect(binaryChanged.selectionDigest).not.toBe(templateChanged.selectionDigest);
    expect(binaryChanged.executableDigest).not.toBe(templateChanged.executableDigest);
  });

  it.each(["/\n", "relative/path\n", "/a/../b\n", "/a\n/b\n", "/a\r/b\n", "/a/\n", "/a\0b\n"])(
    "rejects malformed selection output %j", async (output) => {
      await toolchain();
      mock.developerOutput = output;
      await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
    },
  );

  it("rejects selection outside the selected developer directory", async () => {
    await toolchain();
    mock.executableOutput = "/usr/bin/git\n";
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
  });

  it("rejects a failed OS discovery with a named setup error", async () => {
    await toolchain();
    mock.osFailure = true;
    await expect(discoverInstalledAppleGit()).rejects.toEqual(new Error(selectionError));
  });

  it("rejects group-writable ancestry and untrusted executable ownership", async () => {
    const { developer, executable } = await toolchain();
    await chmod(developer, 0o775);
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
    await chmod(developer, 0o755);
    mock.wrongOwner = executable;
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
  });

  it("rejects an executable or required resource replaced with a symlink", async () => {
    const { executable, templates } = await toolchain();
    const untrusted = join(mock.root, "ungranted-sentinel");
    await writeFile(untrusted, "nonsecret fixture", { mode: 0o755 });
    await rm(executable);
    await symlink(untrusted, executable);
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
    await rm(executable);
    await writeFile(executable, gitBytes, { mode: 0o755 });
    await symlink(untrusted, join(templates, "escaped"));
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
    expect(await readFile(untrusted, "utf8")).toBe("nonsecret fixture");
  });

  it("rejects a missing helper or a required helper redirected outside the named resources", async () => {
    const { helpers } = await toolchain();
    const helper = join(helpers, "git-remote-https");
    await rm(helper);
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
    const untrusted = join(mock.root, "ungranted-helper");
    await writeFile(untrusted, "nonsecret fixture", { mode: 0o755 });
    await symlink(untrusted, helper);
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
  });

  it("rejects a helper link that escapes indirectly through a stock alias", async () => {
    const { executable, helpers } = await toolchain();
    await writeFile(join(dirname(executable), "git-shell"), "nonsecret fixture", { mode: 0o755 });
    await symlink("git-shell", join(helpers, "unexpected-alias"));
    await expect(discoverInstalledAppleGit()).rejects.toThrow(selectionError);
  });

  it.skipIf(process.platform !== "darwin" || process.env.PAPERCLIP_TEST_INSTALLED_APPLE_GIT !== "1")(
    "discovers and hashes the actual installed Apple Git using the OS tools", async () => {
      const selection = await discoverInstalledAppleGit();
      expect(selection.executable).toMatch(/\/usr\/bin\/git$/);
      expect(selection.executableDigest).toBe(createHash("sha256").update(await readFile(selection.executable)).digest("hex"));
      expect(selection.selectionDigest).toMatch(/^[a-f\d]{64}$/);
    },
  );
});

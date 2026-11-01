import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineTool } from "../../src/index.js";
import type { ToolDefinition } from "../../src/index.js";

export const BUGGY_LINE = "return quantity + unitPriceCents;";
export const FIXED_LINE = "return quantity * unitPriceCents;";
export const USER_NOTE = "\n用户已有修改：不得覆盖此备注。\n";

const fixturePath = fileURLToPath(new URL("./coding-project/", import.meta.url));
const tempParent = fileURLToPath(new URL("../../.tmp/", import.meta.url));
const processResult = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
const emptyInput = z.object({}).strict();

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 两个工作区都进入工具后才放行，验证实际并发，不靠 sleep 猜时序。 */
export class ReadBarrier {
  private readonly ready = deferred<void>();
  active = 0;
  peak = 0;
  arrivals = 0;

  async enter(signal: AbortSignal): Promise<void> {
    this.active += 1;
    this.arrivals += 1;
    this.peak = Math.max(this.peak, this.active);
    if (this.arrivals === 2) this.ready.resolve();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Read cancelled", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([this.ready.promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
      this.active -= 1;
    }
  }
}

/** 真实本地 I/O 测试边界，不是生产级文件系统/Shell 沙箱。 */
export class CodingWorkspace {
  readonly calls: string[] = [];
  readonly testRuns: CommandResult[] = [];
  readonly testsStarted = deferred<void>();
  private readonly children = new Set<ChildProcess>();
  private readonly idleWaiters = new Set<() => void>();
  private blockNextTest = false;
  private firstRead = true;

  private constructor(
    readonly directory: string,
    readonly root: string,
  ) {}

  static async create(): Promise<CodingWorkspace> {
    await mkdir(tempParent, { recursive: true });
    const directory = await mkdtemp(path.join(tempParent, "coding-"));
    const workspace = new CodingWorkspace(directory, path.join(directory, "repo"));
    try {
      await cp(fixturePath, workspace.root, { recursive: true });
      await writeFile(path.join(directory, "empty.gitconfig"), "");
      await workspace.git(["init", "--quiet"]);
      await workspace.git(["add", "."]);
      await workspace.git([
        "-c",
        "user.name=Coding Fixture",
        "-c",
        "user.email=coding@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ]);
      await writeFile(path.join(workspace.root, "README.md"), (await workspace.read("README.md")) + USER_NOTE);
      return workspace;
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  get activeProcessCount(): number {
    return this.children.size;
  }

  blockNextTestsUntilCancelled(): void {
    this.blockNextTest = true;
  }

  async read(relativePath: string): Promise<string> {
    return readFile(await this.resolveExisting(relativePath), "utf8");
  }

  async patch(relativePath: string, before: string, after: string): Promise<void> {
    // 当前场景只允许改目标源文件，测试和用户说明均受保护。
    assert.equal(relativePath, "src/total.mjs", "WORKSPACE_WRITE_DENIED");
    const target = await this.resolveExisting(relativePath);
    const current = await readFile(target, "utf8");
    assert.equal(current.split(before).length - 1, 1, "PATCH_CONFLICT");
    await writeFile(target, current.replace(before, after));
  }

  async git(args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
    const result = await this.run("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=", ...args], signal);
    assert.equal(result.exitCode, 0, result.stderr);
    return result;
  }

  async runTests(signal?: AbortSignal): Promise<CommandResult> {
    const result = await this.run(process.execPath, ["--test", "test/total.test.mjs"], signal);
    this.testRuns.push(result);
    return result;
  }

  tools(barrier?: ReadBarrier): readonly ToolDefinition[] {
    return [
      defineTool({
        name: "workspace_list",
        description: "列出当前项目源文件与测试文件",
        inputSchema: emptyInput,
        outputSchema: z.object({ files: z.array(z.string()) }),
        effects: "read",
        execute: async (_, { signal }) => {
          signal.throwIfAborted();
          this.calls.push("workspace_list");
          const source = await readdir(path.join(this.root, "src"));
          const tests = await readdir(path.join(this.root, "test"));
          return {
            files: [...source.map((name) => `src/${name}`), ...tests.map((name) => `test/${name}`)],
          };
        },
      }),
      defineTool({
        name: "workspace_read",
        description: "读取当前工作区的一个文件",
        inputSchema: z.object({ path: z.string().min(1) }).strict(),
        outputSchema: z.object({ content: z.string() }),
        effects: "read",
        execute: async (input, { signal }) => {
          this.calls.push("workspace_read");
          if (barrier && this.firstRead) {
            this.firstRead = false;
            await barrier.enter(signal);
          }
          signal.throwIfAborted();
          return { content: await this.read(input.path) };
        },
      }),
      defineTool({
        name: "workspace_patch",
        description: "以匹配原文的方式修改目标源文件",
        inputSchema: z
          .object({
            path: z.string(),
            before: z.string().min(1),
            after: z.string(),
          })
          .strict(),
        outputSchema: z.object({ changed: z.boolean() }),
        effects: "write",
        execute: async (input, { signal }) => {
          signal.throwIfAborted();
          this.calls.push("workspace_patch");
          await this.patch(input.path, input.before, input.after);
          return { changed: true };
        },
      }),
      defineTool({
        name: "tests_run",
        description: "运行当前项目固定的 Node 测试命令",
        inputSchema: emptyInput,
        outputSchema: processResult,
        effects: "read",
        execute: async (_, { signal }) => {
          this.calls.push("tests_run");
          if (this.blockNextTest) {
            this.blockNextTest = false;
            return this.run(
              process.execPath,
              ["-e", "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);"],
              signal,
              (chunk) => {
                if (chunk.includes("READY")) this.testsStarted.resolve();
              },
            );
          }
          return this.runTests(signal);
        },
      }),
      defineTool({
        name: "workspace_diff",
        description: "返回实际 Git diff，包括原有未提交修改",
        inputSchema: emptyInput,
        outputSchema: z.object({ diff: z.string() }),
        effects: "read",
        execute: async (_, { signal }) => {
          this.calls.push("workspace_diff");
          const result = await this.git(["diff", "--no-ext-diff", "--no-color", "HEAD", "--", "."], signal);
          return { diff: result.stdout };
        },
      }),
    ];
  }

  async assertRepaired(): Promise<void> {
    assert.ok((await this.read("src/total.mjs")).includes(FIXED_LINE));
    assert.equal(
      await this.read("test/total.test.mjs"),
      await readFile(path.join(fixturePath, "test/total.test.mjs"), "utf8"),
      "不能修改测试来伪造修复",
    );
    assert.equal(
      await this.read("README.md"),
      (await readFile(path.join(fixturePath, "README.md"), "utf8")) + USER_NOTE,
      "用户已有修改必须原样保留",
    );
    const changed = (await this.git(["diff", "--name-only", "HEAD"])).stdout.trim().split(/\r?\n/).sort();
    assert.deepEqual(changed, ["README.md", "src/total.mjs"]);
    const verification = await this.runTests();
    assert.equal(verification.exitCode, 0, verification.stdout + verification.stderr);
  }

  async dispose(): Promise<void> {
    if (this.children.size) {
      const closed = new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
      for (const child of this.children) child.kill();
      await closed;
    }
    // 删除前核对真实的、由本 fixture 分配的绝对目录；不接受外部路径。
    const allocated = path.resolve(this.directory);
    assert.equal(path.dirname(allocated), path.resolve(tempParent));
    assert.ok(path.basename(allocated).startsWith("coding-"));
    await rm(allocated, { recursive: true, force: true, maxRetries: 3 });
  }

  private async resolveExisting(relativePath: string): Promise<string> {
    const base = await realpath(this.root);
    const resolved = await realpath(path.resolve(base, relativePath));
    const relative = path.relative(base, resolved);
    assert.ok(
      relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "WORKSPACE_PATH_DENIED",
    );
    return resolved;
  }

  private run(
    command: string,
    args: readonly string[],
    signal?: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<CommandResult> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const childEnvironment = { ...process.env };
      // 场景本身也在 node:test 内运行；继承该标记会让子项目测试误用父测试上下文。
      delete childEnvironment.NODE_TEST_CONTEXT;
      const child = spawn(command, [...args], {
        cwd: this.root,
        shell: false,
        windowsHide: true,
        signal,
        env: {
          ...childEnvironment,
          GIT_CONFIG_GLOBAL: path.join(this.directory, "empty.gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      let stdout = "";
      let stderr = "";
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error("Fixture process timed out");
        child.kill();
      }, 10_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        onOutput?.(chunk);
        if (stdout.length > 100_000) {
          failure = new Error("Fixture output exceeded limit");
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 100_000) {
          failure = new Error("Fixture error output exceeded limit");
          child.kill();
        }
      });
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (!this.children.size) {
          for (const done of this.idleWaiters) done();
          this.idleWaiters.clear();
        }
        if (failure) reject(failure);
        else if (signal?.aborted) reject(new DOMException("Command cancelled", "AbortError"));
        else resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }
}

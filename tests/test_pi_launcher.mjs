import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// pi/launcher.zsh 集成测试：经伪 TTY（python pty）走 session-owner 的 pass 路径，捕获 launcher 最终 exec 的参数。
// 覆盖 Pi 1.7.0 的 `--agent-dir <dir>`（heap 诊断目录）与 OSC 7577 Program Resume 重复 `-e` 的去重注入。

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER = join(ROOT, "pi", "launcher.zsh");
const SESSION_OWNER = join(ROOT, "pi", "extensions", "session-owner", "session-owner.ts");
const ZSH = "/bin/zsh";

// 经 python pty.spawn 提供伪 TTY：launcher 仅在 stdin/stdout 均为 TTY 时走 pass 路径并注入扩展
function ptyCommand(command, args) {
  return { file: process.env.PYTHON || "python3", args: ["-c", "import pty,sys; pty.spawn(sys.argv[1:])", command, ...args] };
}

function makeSandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-launcher-")));
  const home = join(root, "home");
  const work = join(root, "work");
  const tmp = join(root, "tmp");
  for (const dir of [home, work, tmp]) mkdirSync(dir, { recursive: true });
  // 伪 pi：打印 node 诊断参数与最终 argv，便于断言 launcher 注入了什么
  const fakePi = join(root, "pi.js");
  writeFileSync(fakePi, 'process.stdout.write("PI_LAUNCH_RESULT=" + JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(2)}) + "\\n");\n');
  return { root, home, work, tmp, fakePi };
}

function runLauncher(sandbox, args, { extraEnv = {}, cwd = sandbox.work } = {}) {
  const { file, args: scriptArgs } = ptyCommand(ZSH, [LAUNCHER, ...args]);
  const env = {
    PATH: process.env.PATH,
    HOME: sandbox.home,
    TMPDIR: `${sandbox.tmp}/`,
    PI_REAL_BIN: sandbox.fakePi,
    PI_CODING_AGENT_DIR: join(sandbox.root, "env-agent"),
    PI_SESSION_OWNER_REGISTRY: "",
    PI_HEAP_DIAGNOSTIC_DIR: "",
    ...extraEnv,
  };
  for (const key of ["PI_SESSION_OWNER_REGISTRY", "PI_HEAP_DIAGNOSTIC_DIR", "PI_CODING_AGENT_DIR"]) if (env[key] === "") delete env[key];
  const result = spawnSync(file, scriptArgs, { cwd, env, encoding: "utf8", timeout: 60_000 });
  const match = /PI_LAUNCH_RESULT=(\{.*\})/.exec(`${result.stdout}\n${result.stderr}`);
  assert.ok(match, `launcher 未到达 exec pi（status=${result.status}）:\n${result.stdout}\n${result.stderr}`);
  return { ...result, launched: JSON.parse(match[1]) };
}

function hasPty() {
  const { file, args } = ptyCommand("/bin/sh", ["-c", "[ -t 0 ] && [ -t 1 ]"]);
  return spawnSync(file, args, { encoding: "utf8" }).status === 0;
}

const options = hasPty() ? {} : { skip: "需要 python3 pty 提供伪 TTY" };

test("launcher.zsh: --agent-dir 决定 heap 诊断目录（支持相对路径与 ~/），优先于 PI_CODING_AGENT_DIR，PI_HEAP_DIAGNOSTIC_DIR 仍最高", options, () => {
  const sandbox = makeSandbox();
  try {
    const relative = runLauncher(sandbox, ["--agent-dir", "./rel-agent"]);
    assert.equal(relative.status, 0, relative.stderr);
    assert.ok(relative.launched.execArgv.includes(`--diagnostic-dir=${join(sandbox.work, "rel-agent", "diagnostics", "heap")}`), JSON.stringify(relative.launched.execArgv));
    assert.ok(existsSync(join(sandbox.work, "rel-agent", "diagnostics", "heap")), "诊断目录应被创建");

    const tilde = runLauncher(sandbox, ["--agent-dir", "~/pi-agent", "-e", "npm:pi-subagents@0.90.0"]);
    assert.ok(tilde.launched.execArgv.includes(`--diagnostic-dir=${join(sandbox.home, "pi-agent", "diagnostics", "heap")}`), JSON.stringify(tilde.launched.execArgv));

    // 其他带值参数的值不得被误认为 --agent-dir
    const misplaced = runLauncher(sandbox, ["--session-dir", "--agent-dir"]);
    assert.ok(misplaced.launched.execArgv.includes(`--diagnostic-dir=${join(sandbox.root, "env-agent", "diagnostics", "heap")}`), JSON.stringify(misplaced.launched.execArgv));

    const forced = runLauncher(sandbox, ["--agent-dir", "~/pi-agent"], { extraEnv: { PI_HEAP_DIAGNOSTIC_DIR: join(sandbox.root, "forced") } });
    assert.ok(forced.launched.execArgv.includes(`--diagnostic-dir=${join(sandbox.root, "forced")}`), JSON.stringify(forced.launched.execArgv));
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("launcher.zsh: OSC 7577 恢复命令已带 -e session-owner.ts 与 -e npm:pi-subagents@0.90.0 时不重复注入", options, () => {
  const sandbox = makeSandbox();
  try {
    const duplicate = runLauncher(sandbox, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0"]);
    assert.equal(duplicate.status, 0, duplicate.stderr);
    assert.deepEqual(duplicate.launched.argv, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0"]);

    // 本地路径按规范化后的绝对路径比较：相对写法 / --extension 别名同样视为已传入
    const relativeDuplicate = runLauncher(sandbox, ["--extension", "./pi/extensions/session-owner/session-owner.ts", "-e", "npm:pi-subagents@0.90.0"], { cwd: ROOT });
    assert.deepEqual(relativeDuplicate.launched.argv, ["--extension", "./pi/extensions/session-owner/session-owner.ts", "-e", "npm:pi-subagents@0.90.0"]);

    // 仅重复一部分：只补齐缺失的那个
    const partial = runLauncher(sandbox, ["-e", SESSION_OWNER]);
    assert.deepEqual(partial.launched.argv, ["-e", "npm:pi-subagents@0.90.0", "-e", SESSION_OWNER]);
    const partialPackage = runLauncher(sandbox, ["-e", "npm:pi-subagents@0.90.0"]);
    assert.deepEqual(partialPackage.launched.argv, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0"]);

    // 其他带值参数的值不得被当作扩展名；`--` 之后的 token 不参与扫描
    const consumed = runLauncher(sandbox, ["--name", "-e"]);
    assert.deepEqual(consumed.launched.argv, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0", "--name", "-e"]);
    const afterSeparator = runLauncher(sandbox, ["--", "-e", "npm:pi-subagents@0.90.0"]);
    assert.deepEqual(afterSeparator.launched.argv, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0", "--", "-e", "npm:pi-subagents@0.90.0"]);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test("launcher.zsh: 无重复 -e 时保持原有参数顺序注入 session-owner 与交互式锁版包", options, () => {
  const sandbox = makeSandbox();
  try {
    const plain = runLauncher(sandbox, ["--agent-dir", "./rel-agent", "--skill", "x"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(plain.launched.argv, ["-e", SESSION_OWNER, "-e", "npm:pi-subagents@0.90.0", "--agent-dir", "./rel-agent", "--skill", "x"]);
    assert.ok(plain.launched.execArgv.some((flag) => flag.startsWith("--max-old-space-size=")));
    assert.ok(plain.launched.execArgv.some((flag) => flag.startsWith("--heapsnapshot-near-heap-limit=")));
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

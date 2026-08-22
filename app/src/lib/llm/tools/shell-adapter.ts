// v0.7 阶段4b — shell 执行适配器
//
// 把 Rust run_shell_command / run_shell_args 包一层（可注入），bash 工具依赖接口而非直接
// 依赖 Tauri，便于单测。安全前置（白名单/拦截/确认）在 bash 工具里做；本适配器只负责
// 执行已批准的命令。
//
// 两条入口的差别（2026-07-10 加 runArgs，避免 L6 写后格式化把文件路径拼回 sh -c 时的
// shell 注入）：
// - run(command)：用户对模型说的"跑这条命令"用，走 `sh -c`，支持管道 / 重定向。
// - runArgs(args)：我们自己拼好的 argv 用，**不经 sh**，路径里的 ; && | 等元字符不会被
//   解释成第二条命令。

import { invoke } from "@tauri-apps/api/core";

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ShellAdapter {
  /** 用户对模型说的命令 —— 走 sh -c（支持管道 / 重定向）。 */
  run(command: string, cwd: string): Promise<ShellResult>;
  /** 内部已构造好的 argv —— 不经 sh，杜绝路径里元字符被解释。 */
  runArgs(args: string[], cwd: string): Promise<ShellResult>;
  /** Trusted ls path: native side revalidates workspace and operands before spawn. */
  runAuthorizedLs?(input: { workspacePath: string; operands: readonly string[] }): Promise<ShellResult>;
}

const tauriShell: ShellAdapter = {
  run: (command, cwd) => invoke<ShellResult>("run_shell_command", { command, cwd }),
  runArgs: (args, cwd) =>
    invoke<ShellResult>("run_shell_args", {
      program: args[0] ?? "",
      args: args.slice(1),
      cwd,
    }),
  runAuthorizedLs: ({ workspacePath, operands }) =>
    invoke<ShellResult>("run_authorized_ls", { workspace: workspacePath, operands: [...operands] }),
};

let active: ShellAdapter = tauriShell;

export function getShellAdapter(): ShellAdapter {
  return active;
}

export function setShellAdapter(a: ShellAdapter): void {
  active = a;
}

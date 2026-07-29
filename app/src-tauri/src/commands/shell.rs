//! bash 工具 + git 操作的后端实现。**安全前置在 TS 侧**（command-safety 白名单 + 危险拦截 +
//! 用户确认 / git-read-tool 只放行 status/diff/log），本模块只负责执行已批准的命令。

use tauri_plugin_shell::ShellExt;

use crate::process::{run_with_idle_timeout, ShellOutput};
use crate::security::{extra_path_dirs, fnv1a_hex, prepend_path_dirs};

fn shell_command_with_path(
    app: &tauri::AppHandle,
    program: &str,
) -> tauri_plugin_shell::process::Command {
    let command = app.shell().command(program);
    match prepend_path_dirs(std::env::var_os("PATH"), extra_path_dirs()) {
        Some(path) => command.env("PATH", path),
        None => command,
    }
}

/// bash 工具单条命令的**静默**上限——按空闲计时，不按总时长计时（跟 sse-chunk-timeout.ts
/// 同一个思路：真在干活的命令会不断吐 stdout/stderr，每来一行就重置计时，pnpm install /
/// cargo build 这类跑几分钟的真实构建永不误触发；只有连续 N 秒**一丁点输出都没有**（连进程
/// 退出事件都没有）才判定为卡死。
/// 卡死的典型触发点：tauri-plugin-shell 的 `Command::stdin()` 接的是一根管道而非继承父进程
/// tty，子进程一旦读 stdin 就永久阻塞在这——没人会往这根管道写字节（例如模型跑了缺 -m 的
/// `git commit` 拉起 $EDITOR 等交互输入、或损坏的 heredoc 让 sh 一直等一个不会出现的结束定界符）。
/// 之前用 `.output()` 对这种情况完全没有超时，会一路挂到 bash 工具的 `execute()` 不 resolve，
/// 进而拖死整条对话的 isStreaming。
const SHELL_IDLE_TIMEOUT_SECS: u64 = 180;

/// git 相关子命令（init/config/add/commit -m/status/diff/log）用的静默上限——这些都是轻量本地
/// 操作，正常情况零点几秒就该出结果，没有理由长时间沉默，超时收紧到 30s 就够，不用等 bash
/// 工具那档的 180s（那档是留给 pnpm install / cargo build 这类真实构建时间的）。
const GIT_IDLE_TIMEOUT_SECS: u64 = 30;

/// 一次性运行一条 shell 命令（在指定工作目录），捕获 stdout/stderr/exit code。
/// v0.7 阶段4b：bash 工具用；用 `sh -c` 以支持白名单命令的参数与管道。
#[tauri::command]
pub async fn run_shell_command(
    app: tauri::AppHandle,
    command: String,
    cwd: String,
) -> Result<ShellOutput, String> {
    let (rx, child) = shell_command_with_path(&app, "sh")
        .args(["-c", &command])
        .current_dir(cwd)
        .spawn()
        .map_err(|e| e.to_string())?;
    run_with_idle_timeout(rx, child, SHELL_IDLE_TIMEOUT_SECS).await
}

/// 走参数数组的"非 sh"执行——`program + args` 直接传给 tauri-plugin-shell，不经过
/// `sh -c` 解释。这样绝对路径里含 `;` / `&&` / `|` 等 shell 元字符时不会被注入。
/// L6 写后自动格式化（`post-write-format.ts`）走这一条，避免把代码文件名拼回
/// sh -c 的字符串；用户对模型说的"跑这条命令"（bash 工具）仍走 `run_shell_command`，
/// 因为用户输入的合法 shell 语法（管道、重定向）需要 sh 解释。
#[tauri::command]
pub async fn run_shell_args(
    app: tauri::AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
) -> Result<ShellOutput, String> {
    let (rx, child) = shell_command_with_path(&app, &program)
        .args(args)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| e.to_string())?;
    run_with_idle_timeout(rx, child, SHELL_IDLE_TIMEOUT_SECS).await
}

/// git_commit_file / init_shadow_git_repo / git_read 共用的 git 子进程执行——同样套
/// run_with_idle_timeout，用 GIT_IDLE_TIMEOUT_SECS（这几个都是轻量本地操作，不该长时间沉默）。
async fn run_git(
    app: &tauri::AppHandle,
    args: Vec<String>,
    cwd: &str,
) -> Result<ShellOutput, String> {
    let (rx, child) = app
        .shell()
        .command("git")
        .args(args)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| e.to_string())?;
    run_with_idle_timeout(rx, child, GIT_IDLE_TIMEOUT_SECS).await
}

/// 2.1 步骤2/3 修复（2026-07-02）：非 git 工作文件夹的影子仓库路径。
/// 参考 OpenCode `snapshot/index.ts` 的思路——快照仓库放在应用私有数据目录，
/// 用 `--git-dir`/`--work-tree` 跟用户目录分离，不会在用户项目里冒出个 `.git`。
/// 用 workspace 路径的 hash 做稳定目录名。
/// 2026-07-02 代码审查发现：不同写法的同一目录（尾部斜杠、符号链接 vs 真实路径）会
/// 算出不同 hash，导致"开启保护"和后续 commit 用的目录对不上——先 canonicalize，
/// 失败（目录当时不存在等）就退回裁剪尾部斜杠的原始字符串，保证 init 和 commit 两次
/// 调用只要传的是同一个真实目录，算出来的 hash 就一致。
fn shadow_git_dir_for_workspace(
    app: &tauri::AppHandle,
    workspace: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let normalized = std::fs::canonicalize(workspace)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| workspace.trim_end_matches('/').to_string());
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    Ok(base.join("snapshots").join(fnv1a_hex(&normalized)))
}

/// 用户主动点击"开启修改保护"时调用——在应用私有目录里给这个
/// 工作文件夹初始化一个影子 git 仓库（不修改用户文件夹本身，不会冒出 `.git`）。
/// 幂等：仓库已存在时 `git init` 本身就是安全的空操作。
/// 顺便配好 user.name/user.email——这是应用内部管理的仓库，不能依赖用户机器上
/// 有没有配过全局 git 身份（很多 vibe coder 用户可能从没跑过 git，配了才不会
/// 每次 commit 都报"Please tell me who you are"）。
#[tauri::command]
pub async fn init_shadow_git_repo(app: tauri::AppHandle, workspace: String) -> Result<(), String> {
    let git_dir = shadow_git_dir_for_workspace(&app, &workspace)?;
    std::fs::create_dir_all(&git_dir)
        .map_err(|e| format!("failed to create shadow git dir: {e}"))?;
    let git_dir_flag = format!("--git-dir={}", git_dir.to_string_lossy());
    let work_tree_flag = format!("--work-tree={workspace}");

    let output = run_git(
        &app,
        vec![
            git_dir_flag.clone(),
            work_tree_flag.clone(),
            "init".to_string(),
        ],
        ".",
    )
    .await?;
    if output.code != Some(0) {
        return Err(output.stderr);
    }

    // 2026-07-02 代码审查发现：原来只检查 spawn 是否成功，没检查 git config 命令本身的
    // 退出码——如果 config 失败（比如权限问题），函数照样返回 Ok(())，用户以为"开启成功"，
    // 但后续 commit 会因为没有 user.name/user.email 报错，表现跟没开启保护一模一样。
    for (key, value) in [
        ("user.name", "Cosmgrid Agent"),
        ("user.email", "agent@cosmgrid.local"),
    ] {
        let cfg = run_git(
            &app,
            vec![
                git_dir_flag.clone(),
                "config".to_string(),
                key.to_string(),
                value.to_string(),
            ],
            ".",
        )
        .await?;
        if cfg.code != Some(0) {
            return Err(format!("failed to set {key}: {}", cfg.stderr));
        }
    }
    Ok(())
}

/// 给单个文件做一次 git commit（AI 写操作后的回滚兜底）。
/// v0.7 阶段4b 增强：路径与消息作为**独立参数**传给 git（不经 sh -c），杜绝 shell 注入。
/// 2.1 步骤2/3 修复：workspace 本身不是 git 仓库时，落回检查有没有已初始化的影子仓库
/// （用户点过"开启修改保护"），有就用 `--git-dir`/`--work-tree` 走影子仓库提交；
/// 两者都没有 → 返回 false（不报错，调用方据此标记 reversible，UI 提示用户去开启保护）。
#[tauri::command]
pub async fn git_commit_file(
    app: tauri::AppHandle,
    workspace: String,
    rel_path: String,
    message: String,
) -> Result<bool, String> {
    let add = run_git(
        &app,
        vec!["add".to_string(), "--".to_string(), rel_path.clone()],
        &workspace,
    )
    .await?;
    if add.code == Some(0) {
        let commit = run_git(
            &app,
            vec![
                "commit".to_string(),
                "-m".to_string(),
                message.clone(),
                "--".to_string(),
                rel_path.clone(),
            ],
            &workspace,
        )
        .await?;
        return Ok(commit.code == Some(0));
    }

    // workspace 本身不是 git 仓库 → 查影子仓库存不存在（用户是否点过"开启修改保护"）
    let shadow_dir = shadow_git_dir_for_workspace(&app, &workspace)?;
    if !shadow_dir.join("HEAD").exists() {
        return Ok(false); // 没开启影子保护，如实告知（不是"没做完"，是用户还没选择开启）
    }

    let git_dir_flag = format!("--git-dir={}", shadow_dir.to_string_lossy());
    let work_tree_flag = format!("--work-tree={workspace}");
    let shadow_add = run_git(
        &app,
        vec![
            git_dir_flag.clone(),
            work_tree_flag.clone(),
            "add".to_string(),
            "--".to_string(),
            rel_path.clone(),
        ],
        ".",
    )
    .await?;
    if shadow_add.code != Some(0) {
        return Ok(false);
    }
    let shadow_commit = run_git(
        &app,
        vec![
            git_dir_flag,
            work_tree_flag,
            "commit".to_string(),
            "-m".to_string(),
            message,
            "--".to_string(),
            rel_path,
        ],
        ".",
    )
    .await?;
    Ok(shadow_commit.code == Some(0))
}

/// 只读 git 查询（status / diff / log）：AI 改完代码后能看到自己改了啥。
/// v0.7 增强-2：参数作为**独立 Vec 传给 git**（不经 sh -c），杜绝 shell 注入；
/// **子命令白名单 + 参数构造在 TS 侧**（git-read-tool 只放行 status/diff/log，绝不传写命令）。
/// 本函数只执行已构造好的只读 git 命令，捕获 stdout/stderr/exit code。
#[tauri::command]
pub async fn git_read(
    app: tauri::AppHandle,
    workspace: String,
    args: Vec<String>,
) -> Result<ShellOutput, String> {
    run_git(&app, args, &workspace).await
}

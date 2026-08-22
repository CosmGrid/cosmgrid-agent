//! 安全边界基础设施：这是 Rust 侧的核心价值区（参见桌面
//! `Cosmgrid-Agent-前后端分层比对与借鉴方案-2026-07-09.md` 的归属规则——安全不能靠前端自觉的
//! 校验必须放这里）。包含：子进程 env 白名单、SSRF/内网地址拦截、符号链接 realpath 解析、
//! CLI 可执行文件路径解析。这些校验一旦放前端，前端代码一改就能绕过，所以必须在这一层。

use std::env;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// LSP / MCP stdio 子进程的 env 白名单——只放行运行必需的变量，防止把宿主进程里的密钥
/// （OPENAI_API_KEY / AWS_SECRET_ACCESS_KEY 等）意外透传给第三方子进程。
pub(crate) fn rpc_base_env<I>(vars: I) -> std::collections::HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "SystemRoot",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PATHEXT",
        "COMSPEC",
    ];
    vars.into_iter()
        .filter(|(key, _)| {
            ALLOWED
                .iter()
                .any(|allowed| key.eq_ignore_ascii_case(allowed))
        })
        .collect()
}

/// 2.2 修复补丁（2026-07-02）：符号链接 realpath 解析改走 Rust 侧。
/// TS 侧 `import("node:fs")` 在 Tauri WKWebView 渲染进程里不可用（既不是 Node.js 运行时
/// 也不是浏览器，`node:fs` 不会被打包也不会在运行时 resolve），之前的注入方式在生产
/// 构建里会静默失败（fallback 到 undefined），2.2 的符号链接逃逸防护实际上从未生效。
/// 只有 Rust 侧有真实文件系统访问权限，走 Tauri command 桥接。
#[tauri::command]
pub fn resolve_realpath(path: String) -> Result<String, String> {
    std::fs::canonicalize(&path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("realpath failed for {path}: {e}"))
}

/// D1 修复回归（2026-07-15 review）：工作文件夹选择器（`useWorkPanel.ts` 的
/// `chooseWorkspace`）允许选磁盘上任意路径，不限 `$HOME`；但 capabilities/default.json
/// 里的 fs 读权限收紧在 `$HOME/**`（历史债 D1）。两者相撞：选外接硬盘 / `/tmp` / 挂载卷等
/// `$HOME` 之外的目录当工作区时，所有文件读取会被 ACL 静默拒绝。
///
/// 参考 opencode 的 external-directory 思路：不整体放宽静态权限（那样敏感目录黑名单之外的
/// 任意路径都能读，攻击面变大），而是在用户实际选中某个工作文件夹时，用 Tauri 的运行时动态
/// ACL（`dynamic-acl` feature）只给这一个目录追加读权限。default.json 里那份静态 capability
/// 的 deny 规则（`.ssh`/`.aws`/`.gnupg`/`.env*`/`secrets.*`）仍然生效——deny 是跨 capability
/// 聚合的（见 tauri::ipc::authority::add_capability_inner），不会因为多加了一份 allow 就被绕过。
#[tauri::command]
pub fn grant_workspace_fs_access(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("工作文件夹路径无效：{path}（{e}）"))?;
    if !canonical.is_dir() {
        return Err(format!("工作文件夹不是目录：{path}"));
    }
    let root = canonical.to_string_lossy().into_owned();

    #[derive(serde::Serialize, Clone)]
    struct FsPathEntry {
        path: String,
    }
    // 目录本身（给 exists/stat/read-dir 用）+ 递归通配（给目录下所有文件用）。
    let entries = vec![
        FsPathEntry { path: root.clone() },
        FsPathEntry {
            path: format!("{root}/**"),
        },
    ];

    // identifier 按目录内容哈希取稳定值：同一目录反复绑定（比如重启会话）不会无限堆叠新
    // capability；不同目录各自独立 identifier，互不覆盖（用户切换多个工作区时旧的仍保留
    // 读权限，跟 opencode「批准过的目录以后都不用再问」的语义一致）。
    let identifier = format!("dynamic-workspace-fs-{}", fnv1a_hex(&root));
    let mut builder = tauri::ipc::CapabilityBuilder::new(identifier).window("main");
    for permission in [
        "fs:allow-read-file",
        "fs:allow-read-text-file",
        "fs:allow-read-dir",
        "fs:allow-exists",
        "fs:allow-stat",
    ] {
        builder = builder.permission_scoped(permission, entries.clone(), Vec::<FsPathEntry>::new());
    }

    app.add_capability(builder).map_err(|e| e.to_string())
}

pub(crate) fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

pub(crate) fn find_in_path(program: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var)
        .map(|dir| dir.join(program))
        .find(|candidate| is_executable_file(candidate))
}

/// 修复（2026-07-02，用户实测发现）：spawn 出去的 claude/codex 进程报
/// `env: node: No such file or directory`。根因不是找不到 claude 本身——
/// `resolve_cli_program`/`find_in_common_locations` 已经能用绝对路径找到 claude——
/// 而是 claude 这类 CLI 脚本内部常有 `#!/usr/bin/env node` 这种 shebang，
/// 这一步是**子进程自己**按它继承到的 PATH 再查一次 node，父进程这边解析出的
/// 绝对路径救不了这一步。GUI app（Dock/Finder 启动，或某些 Tauri dev 场景）
/// 继承的进程 PATH 通常比用户交互式 shell 的 PATH 窄得多，不含 nvm 管理的
/// node 目录，所以必须把这些目录也塞进传给子进程的 PATH 里。
/// 复用 find_in_common_locations 同一套目录来源（homebrew/local/.nvm）。
pub(crate) fn extra_path_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            let mut node_bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin"))
                .filter(|p| p.is_dir())
                .collect();
            node_bins.sort();
            node_bins.reverse(); // 新版本优先
            dirs.extend(node_bins);
        }
    }
    dirs
}

/// 将 GUI 进程常缺失的 Homebrew / nvm 等目录放到子进程 PATH 的前面，同时保留原 PATH。
/// Dock/Finder 启动的桌面程序不会读取交互式 shell 配置；不补这一步，bash 工具就可能
/// 找不到 pnpm、node 或 typescript-language-server。
pub(crate) fn prepend_path_dirs<I>(
    existing_path: Option<std::ffi::OsString>,
    extra_dirs: I,
) -> Option<std::ffi::OsString>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut dirs: Vec<PathBuf> = extra_dirs.into_iter().collect();
    if let Some(existing) = existing_path {
        dirs.extend(env::split_paths(&existing));
    }
    env::join_paths(dirs).ok()
}

#[derive(Debug, Clone)]
pub(crate) struct AuthorizedLsPlan {
    pub(crate) root: PathBuf,
    pub(crate) targets: Vec<PathBuf>,
}

fn sensitive_component(component: &std::ffi::OsStr) -> bool {
    let Some(value) = component.to_str() else {
        return true;
    };
    let value = value.to_ascii_lowercase();
    value == ".ssh"
        || value == ".aws"
        || value == ".gnupg"
        || value == ".env"
        || value.starts_with(".env.")
        || value.starts_with("secret.")
        || value.starts_with("secrets.")
        || value == "keystore.json"
        || value == "id_rsa"
        || value.starts_with("id_rsa.")
}

fn contains_sensitive_component(path: &Path) -> bool {
    path.components().any(|component| match component {
        std::path::Component::Normal(value) => sensitive_component(value),
        _ => false,
    })
}

pub(crate) fn trusted_ls_program() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from("/bin/ls");
    }
    #[cfg(target_os = "linux")]
    {
        return PathBuf::from("/usr/bin/ls");
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        PathBuf::new()
    }
}

pub(crate) fn authorized_ls_environment() -> Vec<(String, String)> {
    vec![
        ("LC_ALL".to_string(), "C".to_string()),
        ("LANG".to_string(), "C".to_string()),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthorizedLsLaunch {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) env: Vec<(String, String)>,
}

pub(crate) fn validate_authorized_ls(
    workspace: &str,
    operands: &[String],
) -> Result<AuthorizedLsPlan, String> {
    if workspace.is_empty() || workspace.contains('\0') {
        return Err("workspace 为空或包含 NUL".to_string());
    }
    let workspace_path = Path::new(workspace);
    if !workspace_path.is_absolute() {
        return Err("workspace 必须是绝对路径".to_string());
    }
    let root = std::fs::canonicalize(workspace_path)
        .map_err(|e| format!("workspace realpath 失败：{e}"))?;
    if !root.is_dir() || root.to_str().is_none() || contains_sensitive_component(&root) {
        return Err("workspace 不是可用目录或包含敏感路径".to_string());
    }

    let mut targets = Vec::with_capacity(if operands.is_empty() {
        1
    } else {
        operands.len()
    });
    let raw_operands: Vec<String> = if operands.is_empty() {
        vec![".".to_string()]
    } else {
        operands.to_vec()
    };
    for operand in raw_operands {
        if operand.is_empty()
            || operand.contains('\0')
            || operand.starts_with('-')
            || operand.starts_with('~')
            || operand.starts_with('@')
            || operand
                .chars()
                .any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
        {
            return Err("ls operand 不符合严格 grammar".to_string());
        }
        let raw = Path::new(&operand);
        let joined = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            root.join(raw)
        };
        let target =
            std::fs::canonicalize(&joined).map_err(|e| format!("ls target realpath 失败：{e}"))?;
        if !target.starts_with(&root)
            || contains_sensitive_component(&target)
            || target.to_str().is_none()
        {
            return Err("ls target 超出 workspace 或包含敏感路径".to_string());
        }
        targets.push(target);
    }
    Ok(AuthorizedLsPlan { root, targets })
}

/// Build the complete native launch description only after the full path plan
/// has passed validation.  The program check uses metadata on the final path
/// component, so a symlink to a regular file is not accepted as trusted.
pub(crate) fn build_authorized_ls_launch_with_program(
    plan: &AuthorizedLsPlan,
    program: &Path,
) -> Result<AuthorizedLsLaunch, String> {
    if !program.is_absolute() {
        return Err("固定可信 ls 程序必须是绝对路径".to_string());
    }
    let metadata =
        std::fs::symlink_metadata(program).map_err(|e| format!("固定可信 ls 不可用：{e}"))?;
    if !metadata.file_type().is_file() {
        return Err("固定可信 ls 必须是最终路径上的普通文件".to_string());
    }
    let program = program
        .to_str()
        .ok_or_else(|| "可信 ls 程序路径不是 UTF-8".to_string())?;
    let mut args = Vec::with_capacity(plan.targets.len() + 1);
    args.push("--".to_string());
    for target in &plan.targets {
        args.push(
            target
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "ls target 不是 UTF-8".to_string())?,
        );
    }
    Ok(AuthorizedLsLaunch {
        program: PathBuf::from(program),
        args,
        cwd: plan.root.clone(),
        env: authorized_ls_environment(),
    })
}

pub(crate) fn prepare_authorized_ls_launch(
    workspace: &str,
    operands: &[String],
) -> Result<AuthorizedLsLaunch, String> {
    let plan = validate_authorized_ls(workspace, operands)?;
    build_authorized_ls_launch_with_program(&plan, &trusted_ls_program())
}

/// Injection seam shared by production and tests: no launcher callback is
/// reached until validation and the complete trusted launch description are
/// ready.  Invalid plans therefore have a mechanically provable zero-launch
/// path.
pub(crate) fn launch_authorized_ls_with<R, F>(
    workspace: &str,
    operands: &[String],
    launcher: F,
) -> Result<R, String>
where
    F: FnOnce(&AuthorizedLsLaunch) -> Result<R, String>,
{
    let launch = prepare_authorized_ls_launch(workspace, operands)?;
    launcher(&launch)
}

pub(crate) fn find_in_common_locations(program: &str) -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut candidates = vec![
        PathBuf::from(format!("/opt/homebrew/bin/{program}")),
        PathBuf::from(format!("/usr/local/bin/{program}")),
        PathBuf::from(format!("/usr/bin/{program}")),
        PathBuf::from(format!("/bin/{program}")),
    ];

    if let Some(home_dir) = home {
        candidates.push(home_dir.join(format!(".local/bin/{program}")));
        let nvm_versions = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_versions) {
            let mut node_bins: Vec<PathBuf> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join(format!("bin/{program}")))
                .collect();
            node_bins.sort();
            node_bins.reverse();
            candidates.extend(node_bins);
        }
    }

    candidates
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
}

pub(crate) fn is_private_ipv4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || o[0] == 0
}

/// web_fetch 工具的 SSRF 防护。跟 TS 侧 `assertSafeUrl` 保持一致（双保险：前端调用前也会挡
/// 一次内网地址），但真正的边界在这里——`fetch_url_backend`/`fetch_url_rendered` 都必须先过
/// 这一关才能发出真实请求。
pub(crate) fn assert_safe_url(raw_url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw_url).map_err(|_| "URL 格式不合法".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("不支持的协议：{}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or_default().to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host == "0.0.0.0"
        || host == "::1"
        || host.ends_with(".local")
    {
        return Err("拒绝访问本机/内网地址".to_string());
    }
    if let Ok(ipv4) = host.parse::<std::net::Ipv4Addr>() {
        if is_private_ipv4(ipv4) {
            return Err("拒绝访问内网/链路本地 IP 段".to_string());
        }
    }
    Ok(parsed)
}

/// FNV-1a（64位）——纯手写，零依赖，输出跨 Rust 版本/平台 100% 稳定。
/// 2026-07-02 代码审查发现：最初用的是 `std::collections::hash_map::DefaultHasher`
/// （SipHash），标准库明确不保证其输出跨版本/跨进程稳定，升级 Rust 工具链后同一
/// workspace 算出的目录名可能变化，旧影子仓库变孤儿。FNV-1a 是教科书级公开算法，
/// 实现完全在我们自己代码里，不依赖任何 std 内部细节，不会有这个问题。
///
/// 放在 security 模块：它的两个调用方（`commands::shell` 的影子 git 仓库目录名、
/// `commands::fetch` 的渲染请求 id）都是"给不可信输入生成一个稳定、不可预测碰撞的本地
/// 标识符"这一类隔离/去重需求，属于安全边界的辅助设施，不是业务逻辑。
pub(crate) fn fnv1a_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::{
        authorized_ls_environment, launch_authorized_ls_with, prepend_path_dirs, rpc_base_env,
        trusted_ls_program, validate_authorized_ls,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn rpc_environment_does_not_inherit_unrelated_secrets() {
        let env = rpc_base_env([
            ("PATH".to_string(), "/bin".to_string()),
            ("HOME".to_string(), "/home/test".to_string()),
            ("OPENAI_API_KEY".to_string(), "secret".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "secret".to_string()),
        ]);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/test"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
    }

    #[test]
    fn prepended_path_keeps_the_existing_path() {
        let existing = std::env::join_paths([PathBuf::from("/usr/bin")]).unwrap();
        let joined = prepend_path_dirs(
            Some(existing),
            [
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
            ],
        )
        .expect("PATH should be joinable");

        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin"),
                PathBuf::from("/usr/bin"),
            ],
        );
    }

    #[test]
    fn authorized_ls_validates_real_targets_and_rejects_escape_without_spawn() {
        let root = std::env::temp_dir().join(format!("cosmgrid-ls-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        let external = root.with_extension("-external");
        let _ = fs::remove_dir_all(&external);
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(external.join("secret.txt"), root.join("src/link")).unwrap();

        let sibling = root.with_file_name(format!(
            "{}-sibling",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&sibling);
        fs::create_dir_all(&sibling).unwrap();

        let valid = validate_authorized_ls(root.to_str().unwrap(), &[]);
        assert!(valid.is_ok());
        assert!(validate_authorized_ls(
            root.to_str().unwrap(),
            &["src/main.rs".to_string(), "src".to_string()]
        )
        .is_ok());
        for operands in [
            vec!["src/link".to_string()],
            vec!["../".to_string()],
            vec![sibling.to_str().unwrap().to_string()],
            vec!["src/main.rs".to_string(), "../".to_string()],
        ] {
            // A failed plan is the pre-spawn proof: the caller has no command to spawn.
            assert!(validate_authorized_ls(root.to_str().unwrap(), &operands).is_err());
        }
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn authorized_ls_rejects_sensitive_components_and_non_utf8() {
        let root =
            std::env::temp_dir().join(format!("cosmgrid-ls-sensitive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".ssh")).unwrap();
        fs::write(root.join(".ssh/config"), "Host *").unwrap();
        for name in [
            ".aws",
            ".gnupg",
            ".env",
            ".env.local",
            "secret.txt",
            "secrets.json",
            "keystore.json",
            "id_rsa",
            "id_rsa.pub",
        ] {
            fs::write(root.join(name), "sensitive").unwrap();
        }
        assert!(validate_authorized_ls(root.to_str().unwrap(), &[]).is_ok());
        fs::write(root.join("notes~today"), "ordinary").unwrap();
        fs::write(root.join("mail@host"), "ordinary").unwrap();
        assert!(validate_authorized_ls(
            root.to_str().unwrap(),
            &["notes~today".to_string(), "mail@host".to_string()],
        )
        .is_ok());
        assert!(validate_authorized_ls(root.to_str().unwrap(), &["~notes".to_string()]).is_err());
        assert!(
            validate_authorized_ls(root.to_str().unwrap(), &["@args.rsp".to_string()]).is_err()
        );
        for name in [
            ".ssh/config",
            ".aws",
            ".gnupg",
            ".env",
            ".env.local",
            "secret.txt",
            "secrets.json",
            "keystore.json",
            "id_rsa",
            "id_rsa.pub",
        ] {
            assert!(
                validate_authorized_ls(root.to_str().unwrap(), &[name.to_string()]).is_err(),
                "{name}"
            );
        }
        assert!(validate_authorized_ls(root.join(".ssh").to_str().unwrap(), &[]).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let bad_name = std::ffi::OsString::from_vec(vec![b'b', 0x80]);
            let bad_path = root.join(&bad_name);
            // Some macOS filesystems reject non-UTF-8 names at creation time;
            // Linux CI exercises the real existing non-UTF-8 target below.
            if fs::create_dir_all(&bad_path).is_err() {
                let _ = fs::remove_dir_all(&root);
                return;
            }
            std::os::unix::fs::symlink(&bad_path, root.join("nonutf-link")).unwrap();
            // The operand is UTF-8, but canonicalize resolves it to an existing
            // non-UTF-8 target; lossy conversion must never be used to continue.
            assert!(
                validate_authorized_ls(root.to_str().unwrap(), &["nonutf-link".to_string()])
                    .is_err()
            );
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn authorized_ls_uses_fixed_program_and_locale_only_environment() {
        assert!(trusted_ls_program().is_absolute());
        assert!(matches!(
            trusted_ls_program().to_str(),
            Some("/bin/ls") | Some("/usr/bin/ls")
        ));
        assert_eq!(
            authorized_ls_environment(),
            vec![("LC_ALL".into(), "C".into()), ("LANG".into(), "C".into())]
        );
        assert!(!authorized_ls_environment()
            .iter()
            .any(|(key, _)| key == "PATH" || key == "HOME" || key.contains("KEY")));
        let original_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "/tmp/fake-ls-before:/usr/bin");
        assert!(matches!(
            trusted_ls_program().to_str(),
            Some("/bin/ls") | Some("/usr/bin/ls")
        ));
        if let Some(path) = original_path {
            std::env::set_var("PATH", path);
        } else {
            std::env::remove_var("PATH");
        }
    }

    #[test]
    fn authorized_ls_launcher_is_not_called_for_any_invalid_plan_and_receives_final_spec() {
        let root = std::env::temp_dir().join(format!("cosmgrid-ls-launch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        let external = root.with_file_name(format!(
            "{}-outside",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&external);
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("secret"), "outside").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(external.join("secret"), root.join("escape")).unwrap();
        let sibling = root.with_file_name(format!(
            "{}-sibling",
            root.file_name().unwrap().to_string_lossy()
        ));
        let _ = fs::remove_dir_all(&sibling);
        fs::create_dir_all(&sibling).unwrap();

        for operands in [
            vec!["../".to_string()],
            vec![sibling.to_str().unwrap().to_string()],
            vec!["/tmp".to_string()],
            vec!["escape".to_string()],
            vec![".env".to_string()],
            vec!["-la".to_string()],
            vec!["src/main.rs".to_string(), "../".to_string()],
        ] {
            let mut launches = 0;
            let result = launch_authorized_ls_with(root.to_str().unwrap(), &operands, |_spec| {
                launches += 1;
                Ok::<(), String>(())
            });
            assert!(result.is_err());
            assert_eq!(
                launches, 0,
                "invalid operands must never reach launcher: {operands:?}"
            );
        }

        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            let bad_name = std::ffi::OsString::from_vec(vec![b'n', 0x80]);
            let bad_path = root.join(&bad_name);
            if fs::create_dir_all(&bad_path).is_ok() {
                std::os::unix::fs::symlink(&bad_path, root.join("nonutf-link")).unwrap();
                let mut launches = 0;
                let result = launch_authorized_ls_with(
                    root.to_str().unwrap(),
                    &["nonutf-link".to_string()],
                    |_spec| {
                        launches += 1;
                        Ok::<(), String>(())
                    },
                );
                assert!(result.is_err());
                assert_eq!(launches, 0);
            }
        }

        let mut launches = 0;
        let spec = launch_authorized_ls_with(
            root.to_str().unwrap(),
            &["src/main.rs".to_string()],
            |spec| {
                launches += 1;
                assert_eq!(spec.program, trusted_ls_program());
                assert_eq!(spec.cwd, fs::canonicalize(&root).unwrap());
                assert_eq!(
                    spec.args,
                    vec![
                        "--".to_string(),
                        fs::canonicalize(root.join("src/main.rs"))
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_string()
                    ]
                );
                assert_eq!(spec.env, authorized_ls_environment());
                Ok::<_, String>(spec.clone())
            },
        )
        .unwrap();
        assert_eq!(launches, 1);
        assert_eq!(spec.args[0], "--");

        let canonical_root = fs::canonicalize(&root).unwrap();
        let bare = launch_authorized_ls_with(root.to_str().unwrap(), &[], |spec| {
            assert_eq!(
                spec.args,
                vec![
                    "--".to_string(),
                    canonical_root.to_str().unwrap().to_string()
                ]
            );
            Ok::<_, String>(())
        });
        assert!(bare.is_ok());
        let multi = launch_authorized_ls_with(
            root.to_str().unwrap(),
            &["src".to_string(), "src/main.rs".to_string()],
            |spec| {
                assert_eq!(
                    spec.args,
                    vec![
                        "--".to_string(),
                        fs::canonicalize(root.join("src"))
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_string(),
                        fs::canonicalize(root.join("src/main.rs"))
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .to_string(),
                    ]
                );
                Ok::<_, String>(())
            },
        );
        assert!(multi.is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let fake_dir = root.join("fake-bin");
            fs::create_dir_all(&fake_dir).unwrap();
            let marker = root.join("fake-ls-ran");
            let fake_ls = fake_dir.join("ls");
            fs::write(
                &fake_ls,
                format!("#!/bin/sh\nprintf hit > '{}'\n", marker.to_str().unwrap()),
            )
            .unwrap();
            fs::set_permissions(&fake_ls, fs::Permissions::from_mode(0o755)).unwrap();
            let result = launch_authorized_ls_with(root.to_str().unwrap(), &[], |spec| {
                assert_eq!(spec.program, trusted_ls_program());
                assert!(!spec.env.iter().any(|(key, _)| key == "PATH"));
                let output = std::process::Command::new(&spec.program)
                    .args(&spec.args)
                    .env_clear()
                    .envs(spec.env.iter().map(|(key, value)| (key, value)))
                    .env("PATH", fake_dir.to_str().unwrap())
                    .current_dir(&spec.cwd)
                    .output()
                    .unwrap();
                assert!(output.status.success());
                Ok::<_, String>(())
            });
            assert!(result.is_ok());
            assert!(!marker.exists(), "PATH fake ls sentinel must not run");
        }

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&external);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn authorized_ls_launcher_rejects_missing_directory_and_symlink_programs() {
        let root = std::env::temp_dir().join(format!("cosmgrid-ls-program-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let plan = validate_authorized_ls(root.to_str().unwrap(), &[]).unwrap();
        let missing = root.join("missing-ls");
        let directory = root.join("ls-dir");
        fs::create_dir_all(&directory).unwrap();
        assert!(super::build_authorized_ls_launch_with_program(&plan, &missing).is_err());
        assert!(super::build_authorized_ls_launch_with_program(&plan, &directory).is_err());
        #[cfg(unix)]
        {
            let target = root.join("real-ls");
            fs::write(&target, "not executable").unwrap();
            let link = root.join("ls-link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert!(super::build_authorized_ls_launch_with_program(&plan, &link).is_err());
        }
        let _ = fs::remove_dir_all(&root);
    }
}

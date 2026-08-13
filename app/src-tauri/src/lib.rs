// Cosmgrid-Agent Tauri 2 入口
// v0.3：注册 tauri-plugin-sql + tauri-plugin-store，不写 Rust 业务逻辑
// v0.7：新增 tauri-plugin-shell + spawn_cli_stream 命令——spawn 本机 CLI（claude/codex）
//        吃订阅额度。这是「平台能力」（spawn 子进程必须在 Rust），不是业务逻辑：
//        模型路由 / 计费 / 解析仍全在 TS。
//
// 2026-07-09：按桌面《Cosmgrid-Agent-前后端分层比对与借鉴方案》Phase A 拆分——原来 1317 行的
// 单文件平铺拆成 commands/（薄 command 入口，按领域分文件）+ process/（子进程生命周期基础设施）
// + security/（安全边界：env 白名单 / SSRF / realpath / PATH 解析，这是 Rust 侧的核心价值区）。
// 只做物理拆分，不改变任何行为。

mod commands;
mod process;
mod security;

use commands::cli::{kill_cli, resolve_cli_program, spawn_cli_stream, CliChildren};
use commands::fetch::{
    fetch_url_backend, fetch_url_rendered, report_rendered_page, RenderChannels,
};
use commands::keychain::{delete_api_key, get_api_key, save_api_key};
use commands::menu::set_menu_language;
use commands::rpc::{kill_rpc_process, spawn_rpc_process, write_rpc_stdin, RpcChildren};
use commands::shell::{
    git_commit_file, git_read, init_shadow_git_repo, run_shell_args, run_shell_command,
};
use security::{grant_workspace_fs_access, resolve_realpath};

use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri::WindowEvent;

// 窗口关闭看门狗超时（2026-07-13 真实事故：点击关闭无响应，此前两次修复只给了 JS 侧
// 清理阶段加超时，但清理完之后真正调用 destroy()/close() 那一步完全没有保护——如果这个
// IPC 往返因为任何原因挂起，JS 层加多少 Promise.race 都没用，因为"不再等待"不等于
// "窗口真的关闭了"。这里在 Rust 侧起一个独立于 webview/IPC 的 tokio 定时任务：无论 JS
// 那边清理/关闭逻辑是否卡住，都保证收到关闭请求后固定时间内强制终止整个进程。多数情况下
// JS 侧会在这之前就正常关闭，看门狗根本不会触发；只有在 JS/IPC 真的失控时才兜底。
const WINDOW_CLOSE_WATCHDOG_SECS: u64 = 5;

fn is_main_window(label: &str) -> bool {
    label == "main"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例保护：重复启动（Dock 图标重复点 / 崩溃残留进程 / Finder 重复双击）会导致
        // 两个进程同时抢占同一个 SQLite 文件，触发数据库打开失败或写入静默失败（"新对话"点了没反应）。
        // 第二个实例启动时转发事件给已在跑的实例并直接退出，不新建进程。必须是第一个注册的插件。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .on_window_event(|window, event| {
            // 这里只能守护主窗口。web_fetch 会创建 render-* 隐藏窗口并在抓取结束后
            // 主动 close；Tauri 的 close() 同样会发 CloseRequested。若不按 label 过滤，
            // 隐藏窗口关闭 5 秒后也会 app_handle.exit(0)，表现就是“发消息后应用退出”。
            if !is_main_window(window.label()) {
                return;
            }
            if let WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(WINDOW_CLOSE_WATCHDOG_SECS)).await;
                    app_handle.exit(0);
                });
            }
        })
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CliChildren::default())
        .manage(RpcChildren::default())
        .manage(RenderChannels::default())
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "edit_select_all" {
                let _ = app.emit("menu-select-all", ());
            }
        })
        .setup(|_app| {
            // 设初始原生菜单（macOS）。默认 zh，前端 i18n 就绪后会按真实语言重设。
            #[cfg(target_os = "macos")]
            {
                let menu = commands::menu::build_localized_menu(_app.handle(), "zh-CN")?;
                _app.set_menu(menu)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            get_api_key,
            delete_api_key,
            spawn_cli_stream,
            kill_cli,
            spawn_rpc_process,
            write_rpc_stdin,
            kill_rpc_process,
            resolve_cli_program,
            run_shell_command,
            run_shell_args,
            fetch_url_backend,
            fetch_url_rendered,
            report_rendered_page,
            git_commit_file,
            git_read,
            init_shadow_git_repo,
            resolve_realpath,
            grant_workspace_fs_access,
            set_menu_language
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_main_window;

    #[test]
    fn only_the_main_window_owns_the_app_exit_watchdog() {
        assert!(is_main_window("main"));
        assert!(!is_main_window("render-request-1"));
        assert!(!is_main_window("settings"));
    }
}

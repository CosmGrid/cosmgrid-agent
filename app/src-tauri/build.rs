fn main() {
    // report_rendered_page 是我们自己的 #[tauri::command]，不是插件命令，默认不会出现在任何
    // ACL manifest 里。render-* 窗口加载的是外部网站（remote origin，见 lib.rs
    // fetch_url_rendered），Tauri 对 remote origin 一律强制走权限检查——没有这行声明，
    // 注入脚本回传内容的 invoke('report_rendered_page', ...) 永远会被拒绝，
    // fetch_url_rendered 每次都会在超时后失败。
    //
    // 注意：一旦声明了 app manifest，`has_app_acl` 这个开关是全局的（见 tauri 源码
    // ipc/authority.rs 的 has_app_acl 字段），不是按命令区分——之前所有自定义命令
    // 在本地 origin 下都是"没声明权限也放行"，声明了任何一个之后，全部自定义命令
    // 都会被强制走权限检查。所以这里必须把 invoke_handler 里注册的全部命令都列出来，
    // 否则会连带炸掉 CLI spawn / git 提交 / API Key 存取这些已经在跑的功能。
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "save_api_key",
            "get_api_key",
            "delete_api_key",
            "spawn_cli_stream",
            "kill_cli",
            "spawn_rpc_process",
            "write_rpc_stdin",
            "kill_rpc_process",
            "resolve_cli_program",
            "run_shell_command",
            "run_shell_args",
            "run_authorized_ls",
            "fetch_url_backend",
            "fetch_url_rendered",
            "report_rendered_page",
            "git_commit_file",
            "git_read",
            "init_shadow_git_repo",
            "resolve_realpath",
            "grant_workspace_fs_access",
            "set_menu_language",
        ]));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

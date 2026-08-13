#[test]
fn close_watchdog_is_scoped_to_the_main_window() {
    let source = include_str!("../src/lib.rs");

    assert!(
        source.contains("is_main_window(window.label())"),
        "全局 on_window_event 必须先识别主窗口；隐藏网页渲染窗口关闭时不能启动整个应用的退出看门狗",
    );
}

#[test]
fn configured_primary_window_label_matches_the_watchdog_guard() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");
    let label = config["app"]["windows"][0]["label"].as_str();

    assert_eq!(
        label,
        Some("main"),
        "主窗口 label 必须显式固定为 main，不能让退出看门狗依赖 Tauri 的隐式默认值",
    );
}

#[test]
fn shutdown_diagnostics_do_not_install_raw_signal_handlers() {
    let source = include_str!("../src/lib.rs");

    assert!(
        !source.contains("libc::signal"),
        "信号回调里分配字符串、写文件并调用 process::exit 不是可靠的诊断方案，不能进入桌面运行时",
    );
}

#[test]
fn shutdown_diagnostics_do_not_write_to_a_shared_fixed_tmp_path() {
    let lib_source = include_str!("../src/lib.rs");
    let main_source = include_str!("../src/main.rs");

    assert!(
        !lib_source.contains("/tmp/cosmgrid-diagnostic.log")
            && !main_source.contains("/tmp/cosmgrid-diagnostic.log"),
        "固定 /tmp 路径可被其他本地进程预先占用或替换；生产应用不能用它做退出日志",
    );
}

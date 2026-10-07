#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    for (key, value) in
        knowledge_vault_app_lib::webkit_env::defaults(|k| std::env::var_os(k).is_some())
    {
        // SAFETY: the first statement of main, before any thread (Tauri, the engine, the host server) exists.
        unsafe { std::env::set_var(key, value) };
    }
    knowledge_vault_app_lib::run();
}

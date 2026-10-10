#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    use knowledge_vault_app_lib::webkit_env;
    for (key, value) in webkit_env::defaults(|k| std::env::var(k).ok(), webkit_env::Gpu::probe) {
        // SAFETY: the first statement of main, before any thread (Tauri, the engine, the host server) exists.
        unsafe { std::env::set_var(key, value) };
    }
    knowledge_vault_app_lib::run();
}

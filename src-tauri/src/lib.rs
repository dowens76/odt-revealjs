use std::fs;
use std::path::PathBuf;
use tauri::{ipc::Response, AppHandle, Manager};

const TEMPLATES_FILE: &str = "templates.json";

/// Read a user-chosen file (from the open dialog or drag-and-drop) as raw bytes.
#[tauri::command]
fn read_binary(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

/// Write text to a user-chosen path (from the save dialog).
#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("Could not write {path}: {e}"))
}

fn templates_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(TEMPLATES_FILE))
}

/// Saved templates as a JSON array (empty array when none have been saved yet).
#[tauri::command]
fn load_templates(app: AppHandle) -> Result<String, String> {
    let path = templates_path(&app)?;
    if !path.exists() {
        return Ok("[]".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_templates(app: AppHandle, json: String) -> Result<(), String> {
    let path = templates_path(&app)?;
    // Write to a temp file first so a crash mid-write can't corrupt saved templates.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_binary,
            write_text,
            load_templates,
            save_templates
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

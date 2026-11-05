use serde::Serialize;
use std::{fs, net::TcpListener, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{Manager, State};

#[derive(Clone, Serialize)]
struct Connection { url: String, token: String }
struct Backend { child: Child, connection: Connection }
#[derive(Default)]
struct Runtime(Mutex<Option<Backend>>);

fn uv_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("GAGGIMATE_UV") { return path.into(); }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    for path in [home.join(".local/bin/uv"), PathBuf::from("/opt/homebrew/bin/uv"), PathBuf::from("/usr/local/bin/uv")] {
        if path.is_file() { return path; }
    }
    PathBuf::from("uv")
}

#[tauri::command]
fn backend_connection(app: tauri::AppHandle, state: State<Runtime>) -> Result<Connection, String> {
    let mut runtime = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(backend) = runtime.as_mut() {
        if backend.child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Ok(backend.connection.clone());
        }
    }
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().map_err(|e| e.to_string())?
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime")
    };
    let data = if cfg!(debug_assertions) { root.join("data") } else { app.path().app_data_dir().map_err(|e| e.to_string())? };
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let connection = Connection { url: format!("http://127.0.0.1:{port}"), token: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()) };
    let log = fs::OpenOptions::new().create(true).truncate(true).write(true).open(data.join("desktop-backend.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(uv_executable());
    command.args(["run", "--frozen", "--project"]).arg(&root)
        .args(["python", "-m", "gaggimate_mcp.desktop", "--port", &port.to_string(), "--data-dir"])
        .arg(&data).arg("--resource-dir").arg(&root)
        .env("PYTHONPATH", root.join("src"))
        .env("GAGGIMATE_DESKTOP_TOKEN", &connection.token)
        .env("PYTHONUNBUFFERED", "1")
        .env("UV_PROJECT_ENVIRONMENT", if cfg!(debug_assertions) { root.join(".venv") } else { data.join(".venv") })
        .current_dir(&data).stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log));
    #[cfg(unix)] {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    drop(listener);
    let child = command.spawn().map_err(|e| format!("Could not start Python backend using uv: {e}. Install uv or set GAGGIMATE_UV to its executable."))?;
    *runtime = Some(Backend { child, connection: connection.clone() });
    Ok(connection)
}

fn stop_backend(app: &tauri::AppHandle) {
    let state = app.state::<Runtime>();
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut backend) = guard.take() {
            #[cfg(unix)] unsafe { libc::kill(-(backend.child.id() as i32), libc::SIGTERM); }
            #[cfg(not(unix))] { let _ = backend.child.kill(); }
            // Reap without blocking the UI thread; the process group includes MCP children.
            std::thread::spawn(move || { let _ = backend.child.wait(); });
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(Runtime::default())
        .invoke_handler(tauri::generate_handler![backend_connection])
        .build(tauri::generate_context!())
        .expect("Could not initialize Gaggimate Studio")
        .run(|app, event| { if matches!(event, tauri::RunEvent::Exit) { stop_backend(app); } });
}

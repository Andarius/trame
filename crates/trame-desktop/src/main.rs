#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "CLI output is the product; stderr is the app log"
)]

#[cfg(target_os = "linux")]
mod appimage;
mod geometry;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicI32, AtomicU16, AtomicU64, Ordering},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[allow(
    clippy::exit,
    reason = "tauri::generate_context! expands to process::exit"
)]
fn main() -> anyhow::Result<()> {
    if let Some(result) = trame_local::pg::supervisor_args() {
        return result;
    }
    #[cfg(target_os = "linux")]
    appimage::detach_mount_runtime();
    let mut config = trame_local::Config::from_env()?;
    if trame_local::isolated_mode() {
        config.root = trame_local::scratch_root(&config.root)?;
    } else {
        // a relaunch right after quit waits for the old instance's PostgreSQL to stop
        drop(trame_local::pg::lock_root_within(
            &config.root,
            std::time::Duration::from_secs(15),
        )?);
    }
    let runtime = Arc::new(tokio::runtime::Runtime::new()?);
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let stop = Arc::new(Mutex::new(Some(stop_tx)));
    let task = Arc::new(Mutex::new(None));
    let started = Arc::new(AtomicBool::new(false));
    let port = Arc::new(AtomicU16::new(0));
    let exit_code = Arc::new(AtomicI32::new(0));
    let setup_task = task.clone();
    let setup_runtime = runtime.clone();
    let setup_exit_code = exit_code.clone();
    let webview_data = config.root.join("webview");
    // under the data root, so isolated runs keep their own size
    let window_file = config.root.join("window.json");
    let startup = Arc::new(Mutex::new(Some((config, stop_rx))));
    let app = tauri::Builder::default().setup(move |app| {
        let resources = app.path().resource_dir()?;
        if let Some((config, _)) = startup.lock().unwrap().as_mut() {
            config.desktop = true;
            if std::env::var_os("TRAME_WEB_DIR").is_none() {
                config.web_dir = resources.join("web");
            }
        }
        if std::env::var_os("TRAME_PG_BIN").is_none() {
            if let Some((config, _)) = startup.lock().unwrap().as_mut() {
                config.pg_bin = resources.join("postgres/lib/postgresql/18/bin");
            }
        }
        let handle = app.handle().clone();
        // SIGTERM (logout, kill) goes through ExitRequested so the backend stops cleanly
        let signal_handle = handle.clone();
        setup_runtime.spawn(async move {
            let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) else { return };
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            signal_handle.exit(0);
        });
        let nav_port = port.clone();
        let save_runtime = setup_runtime.clone();
        let saved = geometry::load(&window_file);
        let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .data_directory(webview_data)
            .title("Trame").inner_size(saved.width, saved.height).maximized(saved.maximized);
        if let Some((x, y)) = saved.position {
            window = window.position(x, y);
        }
        let window = window
            .on_navigation(move |url| {
                url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") ||
                    (url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(nav_port.load(Ordering::SeqCst)))
            })
            .on_page_load(move |window, payload| {
                if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) || started.swap(true, Ordering::SeqCst) { return; }
                println!("Splash loaded before backend startup");
                let Some((config, stop_rx)) = startup.lock().unwrap().take() else { return };
                let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
                let error_window = window.clone();
                let backend_exit_code = setup_exit_code.clone();
                let backend = setup_runtime.spawn(async move {
                    let result = trame_local::run(config, ready_tx, stop_rx).await;
                    if let Err(error) = &result {
                        backend_exit_code.store(1, Ordering::SeqCst);
                        eprintln!("Local backend failed: {error:#}");
                        let message = serde_json::to_string(&format!("Unable to open workspace: {error}. Check the application log before retrying.")).unwrap();
                        let _ = error_window.eval(format!("document.querySelector('[role=status]').textContent={message}"));
                    }
                    result
                });
                *setup_task.lock().unwrap() = Some(backend);
                let port = port.clone();
                let app = handle.clone();
                let exit_code = setup_exit_code.clone();
                setup_runtime.spawn(async move {
                    match ready_rx.await {
                        Ok(bound) => {
                            port.store(bound, Ordering::SeqCst);
                            if window.navigate(format!("http://127.0.0.1:{bound}").parse().unwrap()).is_ok() {
                                println!("Tauri window navigated after backend bind");
                            }
                        }
                        Err(_) => {
                            if std::env::var_os("TRAME_SMOKE_SECONDS").is_some() {
                                exit_code.store(1, Ordering::SeqCst);
                                app.exit(1);
                                return;
                            }
                        }
                    }
                    if let Ok(seconds) = std::env::var("TRAME_SMOKE_SECONDS") {
                        if let Ok(seconds) = seconds.parse::<u64>() {
                            tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
                            app.exit(0);
                        }
                    }
                });
            }).build()?;
        // persist logical geometry shortly after each resize/move, so a kill or reboot keeps it
        let generation = Arc::new(AtomicU64::new(0));
        let last = Arc::new(Mutex::new(saved));
        let tracked = window.clone();
        window.on_window_event(move |event| {
            if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) { return; }
            let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
            let (generation, last, window, path) = (generation.clone(), last.clone(), tracked.clone(), window_file.clone());
            save_runtime.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                if generation.load(Ordering::SeqCst) != mine || window.is_minimized().unwrap_or(true) { return; }
                let Ok(scale) = window.scale_factor() else { return };
                let mut geometry = *last.lock().unwrap();
                geometry.maximized = window.is_maximized().unwrap_or(false);
                // a maximized window keeps the size to restore to when unmaximized
                if !geometry.maximized {
                    if let Ok(size) = window.inner_size() {
                        let size = size.to_logical::<f64>(scale);
                        (geometry.width, geometry.height) = (size.width, size.height);
                    }
                    geometry.position = window.outer_position().ok().map(|p| {
                        let p = p.to_logical::<f64>(scale);
                        (p.x, p.y)
                    });
                }
                *last.lock().unwrap() = geometry;
                if let Err(error) = geometry::save(&path, geometry) {
                    eprintln!("could not save window geometry: {error}");
                }
            });
        });
        Ok(())
    }).build(tauri::generate_context!())?;
    app.run(move |app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(tx) = stop.lock().unwrap().take() {
                api.prevent_exit();
                let _ = tx.send(());
                let backend = task.lock().unwrap().take();
                let handle = app.clone();
                let exit_code = exit_code.clone();
                runtime.spawn(async move {
                    if let Some(task) = backend {
                        let _ = task.await;
                    }
                    handle.exit(exit_code.load(Ordering::SeqCst));
                });
            }
        }
        // macOS Quit (menu, Cmd+Q, Apple Event) terminates without ExitRequested
        tauri::RunEvent::Exit => {
            if let Some(tx) = stop.lock().unwrap().take() {
                let _ = tx.send(());
                if let Some(backend) = task.lock().unwrap().take() {
                    let _ = runtime.block_on(backend);
                }
            }
        }
        _ => {}
    });
    Ok(())
}

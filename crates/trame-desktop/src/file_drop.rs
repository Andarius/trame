use tauri::{DragDropEvent, WebviewWindow, WindowEvent};

/// Files dropped from the file manager: the page types their paths into the shell under the pointer.
pub(crate) fn forward(window: &WebviewWindow, event: &WindowEvent) {
    let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event else {
        return;
    };
    let at = position.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
    let paths: Vec<_> = paths.iter().map(|p| p.to_string_lossy()).collect();
    let detail = serde_json::json!({ "paths": paths, "x": at.x, "y": at.y });
    let _ = window.eval(format!(
        "dispatchEvent(new CustomEvent('trame:file-drop',{{detail:{detail}}}))"
    ));
}

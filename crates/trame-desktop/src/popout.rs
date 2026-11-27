//! A dock shell in a window of its own: the web app opens `/?popout=<id>` (term/TermPopout.tsx).
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// The shell id a `window.open` from the app asks a window for, when the URL is one.
pub(crate) fn requested(url: &Url, port: u16) -> Option<String> {
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port() != Some(port) {
        return None;
    }
    let id = url
        .query_pairs()
        .find(|(k, _)| k == "popout")?
        .1
        .into_owned();
    // it becomes part of a window label
    (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).then_some(id)
}

/// Raises the shell's window, or opens it; closing it gives the shell back to the main window's dock.
pub(crate) fn open(
    app: &AppHandle,
    id: &str,
    url: Url,
    data: PathBuf,
    allowed: impl Fn(&Url) -> bool + Send + 'static,
) {
    let label = format!("term-{id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let closing = app.clone();
    let close_label = label.clone();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .data_directory(data)
        .title("Terminal")
        .inner_size(900.0, 560.0)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_navigation(move |url| {
            // TermPopout's way to close: WebKitGTK's window.close() would leave an empty window
            if url.query().is_some_and(|q| q.starts_with("popout-close")) {
                if let Some(window) = closing.get_webview_window(&close_label) {
                    let _ = window.close();
                }
                return false;
            }
            allowed(url)
        })
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => return eprintln!("could not open a terminal window: {error}"),
    };
    let (app, id) = (app.clone(), id.to_owned());
    let dropped = window.clone();
    window.on_window_event(move |event| {
        crate::file_drop::forward(&dropped, event);
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        // the dock takes the shell back; the page may not have said so itself
        if let Some(main) = app.get_webview_window("main") {
            let message = serde_json::json!({ "close": id });
            let _ = main.eval(format!(
                "new BroadcastChannel('trame:term-popout').postMessage({message})"
            ));
        }
    });
}

/// Closes every terminal window, before the main one goes.
pub(crate) fn close_all(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("term-") {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::requested;

    #[test]
    fn requested_takes_only_app_popout_urls() {
        let at = |u: &str| requested(&u.parse().unwrap(), 4100);
        assert_eq!(
            at("http://127.0.0.1:4100/?popout=0199-ab"),
            Some("0199-ab".into())
        );
        assert_eq!(at("http://127.0.0.1:4101/?popout=0199"), None);
        assert_eq!(at("https://example.com/?popout=0199"), None);
        assert_eq!(at("http://127.0.0.1:4100/?popout=a/b"), None);
        assert_eq!(at("http://127.0.0.1:4100/?page=1"), None);
    }
}

// Render a command's output offscreen to a PNG: `cargo run --example snapshot -- 'cmd' out.png [ms] [WxH]`.
// TRAME_NATIVE_TERM_THEME (a /api/term/theme JSON file) and TRAME_NATIVE_TERM_FONTS (a font folder) set the look.
#[cfg(target_os = "linux")]
fn main() {
    use gtk::prelude::*;
    if let Ok(dir) = std::env::var("TRAME_NATIVE_TERM_FONTS") {
        trame_native_term::use_font_dir(std::path::Path::new(&dir), &std::env::temp_dir());
    }
    gtk::init().expect("gtk init");
    let args: Vec<String> = std::env::args().collect();
    let (command, out) = (args[1].clone(), args[2].clone());
    let wait = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1500);
    let (w, h) = args
        .get(4)
        .and_then(|s| s.split_once('x'))
        .map_or((900, 420), |(w, h)| {
            (w.parse().unwrap(), h.parse().unwrap())
        });
    let mut look = trame_native_term::Look::default();
    if let Ok(path) = std::env::var("TRAME_NATIVE_TERM_THEME") {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        look.theme = v["theme"].clone();
        if let Some(px) = v["fontSize"].as_f64() {
            look.px = px;
        }
    }
    let window = gtk::OffscreenWindow::new();
    window.set_default_size(w, h);
    let term = trame_native_term::terminal_with(Some(&command), &look);
    window.add(&term);
    window.show_all();
    gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(wait), move || {
        window
            .pixbuf()
            .expect("pixbuf")
            .savev(&out, "png", &[])
            .expect("save png");
        gtk::main_quit();
    });
    gtk::main();
}

#[cfg(not(target_os = "linux"))]
fn main() {}

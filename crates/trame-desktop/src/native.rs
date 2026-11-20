// POC: native terminal panes under a transparent webview, so the page's overlays draw over them.
use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gtk::{cairo, glib, prelude::*};
use serde_json::Value;
use trame_native_term::{LinkEvent, Look, Pane};

struct Layer {
    overlay: gtk::Overlay,
    fixed: gtk::Fixed,
    look: Look,
    win: tauri::WebviewWindow,
    panes: HashMap<String, Rc<Pane>>,
    bg: (f64, f64, f64),
}

fn color(v: &Value) -> Option<(f64, f64, f64)> {
    // "rgb(r, g, b)" from getComputedStyle, or "#rrggbb"
    let s = v.as_str()?;
    if let Some(hex) = s.strip_prefix('#') {
        let n = u32::from_str_radix(hex.get(..6)?, 16).ok()?;
        return Some((
            f64::from((n >> 16) & 255) / 255.0,
            f64::from((n >> 8) & 255) / 255.0,
            f64::from(n & 255) / 255.0,
        ));
    }
    let inner = s.split_once('(')?.1.trim_end_matches(')');
    let mut it = inner.split(',').map(|p| p.trim().parse::<f64>().ok());
    Some((
        it.next()??.min(255.0) / 255.0,
        it.next()??.min(255.0) / 255.0,
        it.next()??.min(255.0) / 255.0,
    ))
}

/// Swap the window's content for [native panes] under [the webview], wired to the page's pane layout.
pub(crate) fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let vbox = window.default_vbox()?;
    for c in vbox.children() {
        eprintln!(
            "native: vbox child {} {}x{}",
            c.type_().name(),
            c.allocated_width(),
            c.allocated_height()
        );
    }
    let Some(webview) = vbox
        .children()
        .into_iter()
        .find(|c| c.type_().name().contains("WebView"))
    else {
        eprintln!("native: no webview in the window box");
        return Ok(());
    };
    vbox.remove(&webview);
    let overlay = gtk::Overlay::new();
    let fixed = gtk::Fixed::new();
    overlay.add(&fixed);
    overlay.add_overlay(&webview);
    vbox.pack_start(&overlay, true, true, 0);
    overlay.show_all();

    let mut look = Look::default();
    if let Some(v) = trame_local::pty::ghostty_theme() {
        look.theme = v["theme"].clone();
        look.px = v["fontSize"].as_f64().unwrap_or(look.px);
    }
    let layer = Rc::new(RefCell::new(Layer {
        overlay: overlay.clone(),
        fixed: fixed.clone(),
        look,
        win: window.clone(),
        panes: HashMap::new(),
        bg: (0.0, 0.0, 0.0),
    }));

    // the page is transparent around the panes: paint its own background under it
    let l = layer.clone();
    fixed.connect_draw(move |w, cr| {
        let (r, g, b) = l.borrow().bg;
        cr.set_source_rgb(r, g, b);
        cr.rectangle(
            0.0,
            0.0,
            f64::from(w.allocated_width()),
            f64::from(w.allocated_height()),
        );
        let _ = cr.fill();
        glib::Propagation::Proceed
    });

    let mut rx = trame_local::pty::native_channel().subscribe();
    let l = layer.clone();
    glib::MainContext::default().spawn_local(async move {
        while rx.changed().await.is_ok() {
            let v = rx.borrow_and_update().clone();
            apply(&l, &v);
        }
    });

    // debug for checking the POC without a person: {"shot": path} draws the window, {"eval": js} runs in the page
    let mut dbg = trame_local::pty::native_debug().subscribe();
    let win = window.clone();
    let dl = layer.clone();
    glib::MainContext::default().spawn_local(async move {
        while dbg.changed().await.is_ok() {
            let v = dbg.borrow_and_update().clone();
            if let Some(path) = v["shot"].as_str() {
                if let Ok(gw) = win.gtk_window() {
                    let (w, h) = (gw.allocated_width(), gw.allocated_height());
                    if let Ok(surface) = cairo::ImageSurface::create(cairo::Format::ARgb32, w, h) {
                        if let Ok(cr) = cairo::Context::new(&surface) {
                            gw.draw(&cr);
                        }
                        if let Some(pix) = gtk::gdk::pixbuf_get_from_surface(&surface, 0, 0, w, h) {
                            let _ = pix.savev(path, "png", &[]);
                        }
                    }
                }
            }
            if v["info"].as_bool() == Some(true) {
                if let Ok(gw) = win.gtk_window() {
                    fn dump(w: &gtk::Widget, depth: usize) {
                        eprintln!(
                            "native: {}{} visible={} mapped={} realized={} {}x{} window={}",
                            "  ".repeat(depth),
                            w.type_().name(),
                            w.is_visible(),
                            w.is_mapped(),
                            w.is_realized(),
                            w.allocated_width(),
                            w.allocated_height(),
                            w.has_window()
                        );
                        if let Some(c) = w.downcast_ref::<gtk::Container>() {
                            for child in c.children() {
                                dump(&child, depth + 1);
                            }
                        }
                    }
                    dump(gw.upcast_ref(), 0);
                }
            }
            if let Some(on) = v["web"].as_bool() {
                if let Ok(gw) = win.gtk_window() {
                    fn find(w: &gtk::Widget) -> Option<gtk::Widget> {
                        if w.type_().name().contains("WebView") {
                            return Some(w.clone());
                        }
                        w.downcast_ref::<gtk::Container>()?
                            .children()
                            .iter()
                            .find_map(find)
                    }
                    if let Some(wv) = find(gw.upcast_ref()) {
                        wv.set_visible(on);
                    }
                }
            }
            // {"type": text} goes to every pane's shell; {"mouse": [kind, x, y]} is a synthetic pointer event on the first pane
            if let Some(text) = v["type"].as_str() {
                for id in dl.borrow().panes.keys() {
                    trame_local::pty::native_input(id, text.as_bytes());
                }
            }
            if let Some(text) = v["paste"].as_str() {
                for pane in dl
                    .borrow()
                    .panes
                    .values()
                    .filter(|p| p.widget().is_visible())
                {
                    pane.paste(text);
                }
            }
            if v["escape"].as_bool() == Some(true) {
                if let Ok(gw) = win.gtk_window() {
                    eprintln!(
                        "native: focus is {:?}",
                        gw.focused_widget().map(|f| f.type_().name())
                    );
                    for kind in ["key", "keyup"] {
                        synth(gw.upcast_ref(), kind, 0.0, 0.0);
                    }
                }
            }
            if let Some(m) = v["mouse"].as_array() {
                let pane = dl.borrow().panes.values().next().map(|p| p.widget());
                if let (Some(w), Some(kind)) = (pane, m.first().and_then(Value::as_str)) {
                    let (x, y) = (m[1].as_f64().unwrap_or(0.0), m[2].as_f64().unwrap_or(0.0));
                    synth(&w, kind, x, y);
                }
            }
            if !v["log"].is_null() {
                eprintln!("native: page {}", v["log"]);
            }
            if let Some(js) = v["eval"].as_str() {
                let _ = win.eval(js);
            }
        }
    });
    Ok(())
}

fn apply(layer: &Rc<RefCell<Layer>>, v: &Value) {
    let mut l = layer.borrow_mut();
    if let Some(bg) = color(&v["bg"]) {
        l.bg = bg;
        l.fixed.queue_draw();
    }
    let wanted: Vec<&Value> = v["panes"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    eprintln!("native: layout {}", v);
    for p in &wanted {
        let Some(id) = p["id"].as_str() else { continue };
        let num = |k: &str| p[k].as_f64().unwrap_or(0.0).round() as i32;
        let (x, y, w, h) = (num("x"), num("y"), num("w"), num("h"));
        if w <= 0 || h <= 0 {
            continue;
        }
        if !l.panes.contains_key(id) {
            let Some(pane) = open(id, &l.look, &l.win) else {
                eprintln!("native: no shell {id}");
                continue;
            };
            eprintln!("native: opened {id} at {x},{y} {w}x{h}");
            // an overlay layer over the webview, placed by margins
            let widget = pane.widget();
            widget.set_halign(gtk::Align::Start);
            widget.set_valign(gtk::Align::Start);
            l.overlay.add_overlay(&widget);
            l.panes.insert(id.to_owned(), pane);
        }
        let widget = l.panes[id].widget();
        widget.set_margin_start(x);
        widget.set_margin_top(y);
        widget.set_size_request(w, h);
        widget.show();
        // what the page floats over this pane, in pane coordinates
        let mask: Vec<cairo::RectangleInt> = v["covers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let n = |k: &str| c[k].as_f64().unwrap_or(0.0) as i32;
                cairo::RectangleInt::new(n("x") - x, n("y") - y, n("w"), n("h"))
            })
            .filter(|r| r.x() < w && r.y() < h && r.x() + r.width() > 0 && r.y() + r.height() > 0)
            .collect();
        l.panes[id].set_mask(&mask);
        let dim = v["dim"].as_f64().unwrap_or(0.0);
        l.panes[id].set_dim(dim);
        // a modal backdrop is up: every click belongs to the page (click outside closes it)
        if let (true, Some(gw)) = (dim > 0.0, l.panes[id].widget().window()) {
            gw.input_shape_combine_region(&cairo::Region::create(), 0, 0);
            // and every key too (Esc closes it)
            if l.panes[id].widget().is_focus() {
                if let Some(web) = l
                    .overlay
                    .children()
                    .into_iter()
                    .find(|c| c.type_().name().contains("WebView"))
                {
                    web.grab_focus();
                    eprintln!("native: focus to the page under a modal");
                }
            }
        }
    }
    let shown: Vec<&str> = wanted.iter().filter_map(|p| p["id"].as_str()).collect();
    for (id, pane) in &l.panes {
        if !shown.contains(&id.as_str()) {
            pane.widget().hide();
        }
    }
}

/// A native pane attached to Trame's shell `id`: replayed history, then live output.
fn open(id: &str, look: &Look, win: &tauri::WebviewWindow) -> Option<Rc<Pane>> {
    let (replay, mut feed) = trame_local::pty::native_attach(id)?;
    let (a, b) = (id.to_owned(), id.to_owned());
    let pane = Rc::new(Pane::new(
        look,
        Box::new(move |bytes| trame_local::pty::native_input(&a, bytes)),
        Box::new(move |cols, rows| trame_local::pty::native_resize(&b, cols, rows)),
    ));
    // image paths hovered or clicked: the page shows its usual preview
    let (w, pid) = (win.clone(), id.to_owned());
    pane.on_link(Box::new(move |e| {
        let v = match e {
            LinkEvent::Hover { path, x, y } => {
                serde_json::json!({ "id": pid, "kind": "hover", "path": path, "x": x, "y": y })
            }
            LinkEvent::Open { path, x, y } => {
                serde_json::json!({ "id": pid, "kind": "open", "path": path, "x": x, "y": y })
            }
            LinkEvent::Leave => serde_json::json!({ "id": pid, "kind": "leave" }),
        };
        eprintln!("native: link {v}");
        let _ = w.eval(format!("window.__trameNativeLink?.({v})"));
    }));
    pane.feed(&replay);
    let p = pane.clone();
    glib::MainContext::default().spawn_local(async move {
        while let Some(bytes) = feed.next().await {
            p.feed(&bytes);
        }
        p.exited();
    });
    Some(pane)
}

/// A pointer event delivered straight to a widget, for driving the POC without a person.
#[allow(unsafe_code)]
fn synth(w: &gtk::Widget, kind: &str, x: f64, y: f64) {
    use gtk::gdk::ffi as g;
    use gtk::glib::translate::{FromGlibPtrFull, ToGlibPtr};
    let Some(win) = w.window() else { return };
    let ty = match kind {
        "press" => g::GDK_BUTTON_PRESS,
        "release" => g::GDK_BUTTON_RELEASE,
        "key" => g::GDK_KEY_PRESS,
        "keyup" => g::GDK_KEY_RELEASE,
        _ => g::GDK_MOTION_NOTIFY,
    };
    unsafe {
        let ev = g::gdk_event_new(ty);
        let seat = gtk::gdk::Display::default()
            .and_then(|d| d.default_seat())
            .and_then(|s| s.pointer());
        if ty == g::GDK_KEY_PRESS || ty == g::GDK_KEY_RELEASE {
            let k = &mut (*ev).key;
            k.window = win.to_glib_full();
            (k.keyval, k.hardware_keycode) = (0xff1b, 9);
            if let Some(kb) = gtk::gdk::Display::default()
                .and_then(|d| d.default_seat())
                .and_then(|s| s.keyboard())
            {
                g::gdk_event_set_device(ev, kb.to_glib_none().0);
            }
            w.event(&gtk::gdk::Event::from_glib_full(ev));
            return;
        }
        if ty == g::GDK_MOTION_NOTIFY {
            let m = &mut (*ev).motion;
            m.window = win.to_glib_full();
            (m.x, m.y) = (x, y);
        } else {
            let b = &mut (*ev).button;
            b.window = win.to_glib_full();
            (b.x, b.y, b.button) = (x, y, 1);
        }
        if let Some(dev) = seat {
            g::gdk_event_set_device(ev, dev.to_glib_none().0);
        }
        let ev = gtk::gdk::Event::from_glib_full(ev);
        w.event(&ev);
    }
}

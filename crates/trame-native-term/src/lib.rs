#![cfg(target_os = "linux")]
#![allow(unsafe_code)]

#[allow(
    non_upper_case_globals,
    non_camel_case_types,
    non_snake_case,
    dead_code,
    unreachable_pub,
    clippy::all,
    clippy::pedantic
)]
pub mod ffi {
    include!(concat!(env!("OUT_DIR"), "/vt.rs"));
}

use std::cell::RefCell;
use std::ffi::c_void;
use std::io::Write;
use std::os::fd::RawFd;
use std::ptr::{null, null_mut};
use std::rc::Rc;
use std::time::Instant;

use gtk::prelude::*;
use gtk::{cairo, gdk, glib, pango};
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

const BOLD: u16 = 1 << 0;
const ITALIC: u16 = 1 << 1;
const FAINT: u16 = 1 << 2;
const INVERSE: u16 = 1 << 4;
const STRIKE: u16 = 1 << 6;
const UNDERLINE_MASK: u16 = 0x7 << 8;
const INVISIBLE: u16 = 1 << 5;

// Terminal state

struct Vt {
    term: ffi::GhosttyTerminal,
    rs: ffi::GhosttyRenderState,
    rows: ffi::GhosttyRenderStateRowIterator,
    cells: ffi::GhosttyRenderStateRowCells,
    enc: ffi::GhosttyKeyEncoder,
    ev: ffi::GhosttyKeyEvent,
    mouse_enc: ffi::GhosttyMouseEncoder,
    mouse_ev: ffi::GhosttyMouseEvent,
    // replies the terminal sends back (cursor reports, device attributes)
    replies: Box<Vec<u8>>,
}

unsafe extern "C" fn on_write_pty(
    _t: ffi::GhosttyTerminal,
    userdata: *mut c_void,
    data: *const u8,
    len: usize,
) {
    let out = unsafe { &mut *userdata.cast::<Vec<u8>>() };
    out.extend_from_slice(unsafe { std::slice::from_raw_parts(data, len) });
}

fn sized<T>() -> T {
    let mut v: T = unsafe { std::mem::zeroed() };
    unsafe { ffi::ghostty_sized_init((&raw mut v).cast(), size_of::<T>()) };
    v
}

impl Vt {
    fn new(cols: u16, rows: u16) -> Self {
        let mut vt = Self {
            term: null_mut(),
            rs: null_mut(),
            rows: null_mut(),
            cells: null_mut(),
            enc: null_mut(),
            ev: null_mut(),
            mouse_enc: null_mut(),
            mouse_ev: null_mut(),
            replies: Box::default(),
        };
        unsafe {
            assert_eq!(
                ffi::ghostty_terminal_new(null(), &raw mut vt.term, cols, rows),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_render_state_new(null(), &raw mut vt.rs),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_render_state_row_iterator_new(null(), &raw mut vt.rows),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_render_state_row_cells_new(null(), &raw mut vt.cells),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_key_encoder_new(null(), &raw mut vt.enc),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_key_event_new(null(), &raw mut vt.ev),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_mouse_encoder_new(null(), &raw mut vt.mouse_enc),
                ffi::GHOSTTY_SUCCESS
            );
            assert_eq!(
                ffi::ghostty_mouse_event_new(null(), &raw mut vt.mouse_ev),
                ffi::GHOSTTY_SUCCESS
            );
            let replies: *mut Vec<u8> = &raw mut *vt.replies;
            ffi::ghostty_terminal_set(vt.term, ffi::GHOSTTY_TERMINAL_OPT_USERDATA, replies.cast());
            ffi::ghostty_terminal_set(
                vt.term,
                ffi::GHOSTTY_TERMINAL_OPT_WRITE_PTY,
                on_write_pty as *const c_void,
            );
            // the library keeps only ~10KB of history by default
            let (bytes, lines): (usize, usize) = (10 << 20, 10_000);
            ffi::ghostty_terminal_set(
                vt.term,
                ffi::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES,
                (&raw const bytes).cast(),
            );
            ffi::ghostty_terminal_set(
                vt.term,
                ffi::GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
                (&raw const lines).cast(),
            );
        }
        vt
    }

    fn style(&mut self, theme: &serde_json::Value) {
        unsafe {
            if let Some(c) = hex(&theme["foreground"]) {
                ffi::ghostty_terminal_set(
                    self.term,
                    ffi::GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND,
                    (&raw const c).cast(),
                );
            }
            if let Some(c) = hex(&theme["background"]) {
                ffi::ghostty_terminal_set(
                    self.term,
                    ffi::GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND,
                    (&raw const c).cast(),
                );
            }
            if let Some(c) = hex(&theme["cursor"]) {
                ffi::ghostty_terminal_set(
                    self.term,
                    ffi::GHOSTTY_TERMINAL_OPT_COLOR_CURSOR,
                    (&raw const c).cast(),
                );
            }
            let p = palette(theme);
            ffi::ghostty_terminal_set(
                self.term,
                ffi::GHOSTTY_TERMINAL_OPT_COLOR_PALETTE,
                (&raw const p).cast(),
            );
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        unsafe { ffi::ghostty_terminal_vt_write(self.term, bytes.as_ptr(), bytes.len()) };
    }

    fn resize(&mut self, cols: u16, rows: u16, cw: u32, ch: u32) {
        unsafe { ffi::ghostty_terminal_resize(self.term, cols, rows, cw, ch) };
    }

    fn scroll(&mut self, tag: ffi::GhosttyTerminalScrollViewportTag, delta: isize) {
        let behavior = ffi::GhosttyTerminalScrollViewport {
            tag,
            value: ffi::GhosttyTerminalScrollViewportValue { delta },
        };
        unsafe { ffi::ghostty_terminal_scroll_viewport(self.term, behavior) };
    }

    /// One wheel notch as the app's mouse protocol, or nothing when the app has not asked for mouse input.
    fn wheel(&mut self, up: bool, at: (f64, f64), screen: (u32, u32), cell: (u32, u32)) -> Vec<u8> {
        unsafe {
            ffi::ghostty_mouse_encoder_set_from_terminal(self.mouse_enc, self.term);
            let mut size: ffi::GhosttyMouseEncoderSize = sized();
            (
                size.screen_width,
                size.screen_height,
                size.cell_width,
                size.cell_height,
            ) = (screen.0, screen.1, cell.0, cell.1);
            ffi::ghostty_mouse_encoder_set(
                self.mouse_enc,
                ffi::GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
                (&raw const size).cast(),
            );
            ffi::ghostty_mouse_event_set_action(self.mouse_ev, ffi::GHOSTTY_MOUSE_ACTION_PRESS);
            ffi::ghostty_mouse_event_set_button(
                self.mouse_ev,
                if up {
                    ffi::GHOSTTY_MOUSE_BUTTON_FOUR
                } else {
                    ffi::GHOSTTY_MOUSE_BUTTON_FIVE
                },
            );
            ffi::ghostty_mouse_event_set_position(
                self.mouse_ev,
                ffi::GhosttyMousePosition {
                    x: at.0 as f32,
                    y: at.1 as f32,
                },
            );
            let mut buf = [0u8; 64];
            let mut written = 0usize;
            let r = ffi::ghostty_mouse_encoder_encode(
                self.mouse_enc,
                self.mouse_ev,
                buf.as_mut_ptr(),
                buf.len(),
                &raw mut written,
            );
            if r == ffi::GHOSTTY_SUCCESS {
                buf[..written].to_vec()
            } else {
                Vec::new()
            }
        }
    }

    /// Whether a DEC private mode (like 2004, bracketed paste) is set.
    fn dec_mode(&self, n: u16) -> bool {
        let mut q = ffi::GhosttyTerminalModeConfig {
            mode: n & 0x7FFF,
            value: false,
        };
        unsafe {
            ffi::ghostty_terminal_get(
                self.term,
                ffi::GHOSTTY_TERMINAL_DATA_MODE,
                (&raw mut q).cast(),
            )
        };
        q.value
    }

    fn alt_screen(&self) -> bool {
        let mut screen: ffi::GhosttyTerminalScreen = ffi::GHOSTTY_TERMINAL_SCREEN_PRIMARY;
        unsafe {
            ffi::ghostty_terminal_get(
                self.term,
                ffi::GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
                (&raw mut screen).cast(),
            )
        };
        screen == ffi::GHOSTTY_TERMINAL_SCREEN_ALTERNATE
    }

    fn encode(&mut self, key: ffi::GhosttyKey, mods: u16, text: &str, unshifted: u32) -> Vec<u8> {
        unsafe {
            ffi::ghostty_key_encoder_set_from_terminal(self.enc, self.term);
            ffi::ghostty_key_event_set_action(self.ev, ffi::GHOSTTY_KEY_ACTION_PRESS);
            ffi::ghostty_key_event_set_key(self.ev, key);
            ffi::ghostty_key_event_set_mods(self.ev, mods);
            ffi::ghostty_key_event_set_utf8(
                self.ev,
                ffi::GhosttyString {
                    ptr: text.as_ptr(),
                    len: text.len(),
                },
            );
            ffi::ghostty_key_event_set_unshifted_codepoint(self.ev, unshifted);
            let mut buf = [0u8; 128];
            let mut written = 0usize;
            let r = ffi::ghostty_key_encoder_encode(
                self.enc,
                self.ev,
                buf.as_mut_ptr(),
                buf.len(),
                &raw mut written,
            );
            // the event borrows `text`: clear it before the borrow ends
            ffi::ghostty_key_event_set_utf8(
                self.ev,
                ffi::GhosttyString {
                    ptr: null(),
                    len: 0,
                },
            );
            if r == ffi::GHOSTTY_SUCCESS {
                buf[..written].to_vec()
            } else {
                Vec::new()
            }
        }
    }
}

impl Drop for Vt {
    fn drop(&mut self) {
        unsafe {
            ffi::ghostty_mouse_event_free(self.mouse_ev);
            ffi::ghostty_mouse_encoder_free(self.mouse_enc);
            ffi::ghostty_key_event_free(self.ev);
            ffi::ghostty_key_encoder_free(self.enc);
            ffi::ghostty_render_state_row_cells_free(self.cells);
            ffi::ghostty_render_state_row_iterator_free(self.rows);
            ffi::ghostty_render_state_free(self.rs);
            ffi::ghostty_terminal_free(self.term);
        }
    }
}

// Look

/// The terminal's look, matching the web terminal: an xterm `ITheme` JSON, a CSS font, CSS padding.
pub struct Look {
    pub family: String,
    pub px: f64,
    pub theme: serde_json::Value,
    /// left, top, right, bottom in px (the web dock's `px-2 pt-1 pb-3`)
    pub pad: (f64, f64, f64, f64),
}

impl Default for Look {
    fn default() -> Self {
        Self {
            family: "JetBrains Mono".into(),
            px: 13.0,
            theme: serde_json::Value::Null,
            pad: (8.0, 4.0, 8.0, 12.0),
        }
    }
}

fn hex(v: &serde_json::Value) -> Option<ffi::GhosttyColorRgb> {
    let s = v.as_str()?.strip_prefix('#')?;
    let n = u32::from_str_radix(s.get(..6)?, 16).ok()?;
    Some(ffi::GhosttyColorRgb {
        r: (n >> 16) as u8,
        g: (n >> 8) as u8,
        b: n as u8,
    })
}

/// xterm's 256 colors with the theme's first 16.
fn palette(theme: &serde_json::Value) -> [ffi::GhosttyColorRgb; 256] {
    const NAMES: [&str; 16] = [
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
    ];
    const BASE: [u32; 16] = [
        0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753,
        0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec,
    ];
    let rgb = |n: u32| ffi::GhosttyColorRgb {
        r: (n >> 16) as u8,
        g: (n >> 8) as u8,
        b: n as u8,
    };
    let mut p = [rgb(0); 256];
    for i in 0..16 {
        p[i] = hex(&theme[NAMES[i]]).unwrap_or(rgb(BASE[i]));
    }
    let level = |v: usize| if v == 0 { 0u8 } else { (55 + v * 40) as u8 };
    for i in 0..216 {
        p[16 + i] = ffi::GhosttyColorRgb {
            r: level(i / 36),
            g: level(i / 6 % 6),
            b: level(i % 6),
        };
    }
    for i in 0..24 {
        let g = (8 + i * 10) as u8;
        p[232 + i] = ffi::GhosttyColorRgb { r: g, g, b: g };
    }
    p
}

/// Make a font folder (the web bundle's JetBrains Mono) usable without installing it.
/// Must run before GTK starts: fontconfig reads `FONTCONFIG_FILE` once.
pub fn use_font_dir(dir: &std::path::Path, scratch: &std::path::Path) {
    let conf = scratch.join("trame-fonts.conf");
    let xml = format!(
        "<?xml version=\"1.0\"?>\n<fontconfig>\n  <include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>\n  <dir>{}</dir>\n  <cachedir>{}</cachedir>\n</fontconfig>\n",
        dir.display(),
        scratch.join("fc-cache").display()
    );
    if std::fs::write(&conf, xml).is_ok() {
        // SAFETY: called at startup, before any other thread reads the environment
        unsafe { std::env::set_var("FONTCONFIG_FILE", conf) };
    }
}

// Drawing

type Rgb = (f64, f64, f64);

fn rgb(c: ffi::GhosttyColorRgb) -> Rgb {
    (
        f64::from(c.r) / 255.0,
        f64::from(c.g) / 255.0,
        f64::from(c.b) / 255.0,
    )
}

struct Fonts {
    faces: [pango::FontDescription; 4], // regular, bold, italic, bold italic
    cw: f64,
    ch: f64,
    ascent: f64,
}

impl Fonts {
    fn new(ctx: &pango::Context, family: &str, px: f64) -> Self {
        let mut base = pango::FontDescription::new();
        base.set_family(&format!("{family},monospace"));
        base.set_absolute_size(px * f64::from(pango::SCALE));
        let face = |bold: bool, italic: bool| {
            let mut f = base.clone();
            if bold {
                f.set_weight(pango::Weight::Bold);
            }
            if italic {
                f.set_style(pango::Style::Italic);
            }
            f
        };
        let layout = pango::Layout::new(ctx);
        layout.set_font_description(Some(&base));
        layout.set_text("M");
        let (_, logical) = layout.extents();
        let metrics = ctx.metrics(Some(&base), None);
        if std::env::var_os("TRAME_NATIVE_TERM_DEBUG").is_some() {
            let used = ctx.load_font(&base).map(|f| f.describe().to_string());
            eprintln!("native-term font: asked {base} got {used:?}");
        }
        let scale = f64::from(pango::SCALE);
        Self {
            faces: [
                face(false, false),
                face(true, false),
                face(false, true),
                face(true, true),
            ],
            cw: f64::from(logical.width()) / scale,
            // a laid-out line's height, as xterm measures a span
            ch: (f64::from(logical.height()) / scale).floor(),
            ascent: (f64::from(metrics.ascent()) / scale).round(),
        }
    }
}

struct Run {
    x: u16,
    cells: u16,
    text: String,
    fg: Rgb,
    face: usize,
    // underline kind (0 none) and strikethrough
    deco: (u16, bool),
}

/// Where input goes and resizes land: an own pty, or a shell owned elsewhere (Trame's sessions).
enum Io {
    Pty {
        master: Box<dyn MasterPty>,
        writer: Box<dyn Write>,
    },
    Remote {
        input: Box<dyn Fn(&[u8])>,
        resize: Box<dyn Fn(u16, u16)>,
    },
}

struct Term {
    vt: Vt,
    io: Io,
    fonts: Fonts,
    cols: u16,
    rows: u16,
    cache: Option<cairo::ImageSurface>,
    focused: bool,
    exited: bool,
    // the viewport moved: repaint every row
    full: bool,
    pad: (f64, f64, f64, f64),
    // latency probe: key press → first frame drawn after the echo arrived
    key_at: Option<Instant>,
    echo_of: Option<Instant>,
    samples: Vec<f64>,
    hud: String,
    clip: Option<cairo::Region>,
    dim: f64,
    // each viewport row's cell text, for selection and links
    lines: Vec<Vec<String>>,
    // selection anchor and head as viewport (col, row); `dragging` until the button is released
    sel: Option<((u16, u16), (u16, u16))>,
    dragging: bool,
    // the viewport is scrolled up into the scrollback
    scrolled: bool,
    // the image path or URL under the pointer: row, columns, target
    link: Option<(u16, u16, u16, String)>,
    on_link: Option<Box<dyn Fn(LinkEvent)>>,
    // probe: time spent in each draw
    draw_ms: Vec<f64>,
    // probe: the whole window paint (all widgets) per frame
    paint_ms: Vec<f64>,
    echo_ms: Vec<f64>,
}

/// An image path or URL the pointer is over (pane pixels), or was clicked.
pub enum LinkEvent {
    Hover { path: String, x: f64, y: f64 },
    Open { path: String, x: f64, y: f64 },
    Leave,
}

impl Term {
    /// Paste text: bracketed when the app asked for it (mode 2004), ESC stripped so it can't end the bracket.
    fn paste(&mut self, text: &str) {
        let text = text.replace('\x1b', "");
        if self.vt.dec_mode(2004) {
            self.send(format!("\x1b[200~{text}\x1b[201~").as_bytes());
        } else {
            self.send(text.replace("\r\n", "\r").replace('\n', "\r").as_bytes());
        }
    }

    /// The viewport cell under a pane pixel, clamped to the grid.
    fn cell_at(&self, x: f64, y: f64) -> (u16, u16) {
        let col = ((x - self.pad.0) / self.fonts.cw)
            .floor()
            .clamp(0.0, f64::from(self.cols - 1)) as u16;
        let row = ((y - self.pad.1) / self.fonts.ch)
            .floor()
            .clamp(0.0, f64::from(self.rows - 1)) as u16;
        (col, row)
    }

    /// The selection from its first cell to its last, or nothing for a bare click.
    fn ordered_sel(&self) -> Option<((u16, u16), (u16, u16))> {
        let (a, b) = self.sel?;
        if a == b {
            return None;
        }
        Some(if (a.1, a.0) <= (b.1, b.0) {
            (a, b)
        } else {
            (b, a)
        })
    }

    /// The selected text, rows joined by newlines and trailing blanks trimmed, like other terminals.
    fn selection_text(&self) -> Option<String> {
        let ((c0, r0), (c1, r1)) = self.ordered_sel()?;
        let rows: Vec<String> = (r0..=r1)
            .map(|r| {
                let line = self
                    .lines
                    .get(usize::from(r))
                    .map_or(&[][..], Vec::as_slice);
                let from = usize::from(if r == r0 { c0 } else { 0 });
                let to = if r == r1 {
                    usize::from(c1) + 1
                } else {
                    line.len()
                };
                line.get(from..to.min(line.len()))
                    .unwrap_or_default()
                    .concat()
                    .trim_end()
                    .to_owned()
            })
            .collect();
        Some(rows.join("\n"))
    }

    /// The image path or URL printed under a cell, as (start col, end col, target).
    fn link_at(&self, col: u16, row: u16) -> Option<(u16, u16, String)> {
        let line = self.lines.get(usize::from(row))?;
        let is_sep = |s: &str| {
            s.chars()
                .all(|c| c.is_whitespace() || "'\"`<>()[]".contains(c))
        };
        let at = usize::from(col);
        if at >= line.len() || is_sep(&line[at]) {
            return None;
        }
        let start = (0..at)
            .rev()
            .take_while(|&i| !is_sep(&line[i]))
            .last()
            .unwrap_or(at);
        let end = (at..line.len()).take_while(|&i| !is_sep(&line[i])).last()? + 1;
        let word = line[start..end].concat();
        let word = word.trim_end_matches([',', ';', ':', '.']);
        if word.starts_with("https://") || word.starts_with("http://") {
            return Some((
                start as u16,
                (start + word.chars().count()) as u16,
                word.to_owned(),
            ));
        }
        let path = word.strip_prefix("file://").unwrap_or(word);
        let lower = path.to_ascii_lowercase();
        let image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
            .iter()
            .any(|e| lower.ends_with(e));
        ((path.starts_with('/') || path.starts_with("~/")) && image).then(|| {
            (
                start as u16,
                (start + word.chars().count()) as u16,
                path.to_owned(),
            )
        })
    }

    fn send(&mut self, bytes: &[u8]) {
        match &mut self.io {
            Io::Pty { writer, .. } => drop(writer.write_all(bytes).and_then(|()| writer.flush())),
            Io::Remote { input, .. } => input(bytes),
        }
    }

    fn flush_replies(&mut self) {
        if !self.vt.replies.is_empty() {
            let out = std::mem::take(&mut *self.vt.replies);
            self.send(&out);
        }
    }

    fn resize(&mut self, width: i32, height: i32) {
        let (l, t, r, b) = self.pad;
        let cols = (((f64::from(width) - l - r) / self.fonts.cw).floor() as u16).max(2);
        let rows = (((f64::from(height) - t - b) / self.fonts.ch).floor() as u16).max(1);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        (self.cols, self.rows) = (cols, rows);
        self.vt
            .resize(cols, rows, self.fonts.cw as u32, self.fonts.ch as u32);
        match &self.io {
            Io::Pty { master, .. } => drop(master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })),
            Io::Remote { resize, .. } => resize(cols, rows),
        }
        self.cache = None;
    }

    fn draw(&mut self, area: &gtk::DrawingArea, cr: &cairo::Context) {
        let (w, h) = (area.allocated_width(), area.allocated_height());
        let scale = area.scale_factor();
        let mut full = std::mem::take(&mut self.full);
        if self
            .cache
            .as_ref()
            .is_none_or(|s| s.width() != w * scale || s.height() != h * scale)
        {
            let Ok(surface) =
                cairo::ImageSurface::create(cairo::Format::Rgb24, w * scale, h * scale)
            else {
                return;
            };
            surface.set_device_scale(f64::from(scale), f64::from(scale));
            self.cache = Some(surface);
            full = true;
        }
        let surface = self.cache.clone().unwrap();
        let vt = &mut self.vt;
        let (colors, cursor) = unsafe {
            ffi::ghostty_render_state_update(vt.rs, vt.term);
            let mut dirty: ffi::GhosttyRenderStateDirty = 0;
            ffi::ghostty_render_state_get(
                vt.rs,
                ffi::GHOSTTY_RENDER_STATE_DATA_DIRTY,
                (&raw mut dirty).cast(),
            );
            full |= dirty == ffi::GHOSTTY_RENDER_STATE_DIRTY_FULL;
            let mut colors: ffi::GhosttyRenderStateColors = sized();
            ffi::ghostty_render_state_get(
                vt.rs,
                ffi::GHOSTTY_RENDER_STATE_DATA_COLORS,
                (&raw mut colors).cast(),
            );
            let mut cursor: ffi::GhosttyRenderStateCursor = sized();
            ffi::ghostty_render_state_get(
                vt.rs,
                ffi::GHOSTTY_RENDER_STATE_DATA_CURSOR,
                (&raw mut cursor).cast(),
            );
            (colors, cursor)
        };
        let (bg, fg) = (rgb(colors.background), rgb(colors.foreground));
        let Ok(c) = cairo::Context::new(&surface) else {
            return;
        };
        if full {
            c.set_source_rgb(bg.0, bg.1, bg.2);
            let _ = c.paint();
        }
        let layout = pangocairo::functions::create_layout(&c);
        // xterm draws without ligatures: `->` stays two cells
        let attrs = pango::AttrList::new();
        attrs.insert(pango::AttrFontFeatures::new("liga 0, clig 0, calt 0"));
        layout.set_attributes(Some(&attrs));
        let (cw, ch) = (self.fonts.cw, self.fonts.ch);
        let mut y = 0u16;
        unsafe {
            ffi::ghostty_render_state_get(
                vt.rs,
                ffi::GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
                (&raw mut vt.rows).cast(),
            );
            while ffi::ghostty_render_state_row_iterator_next(vt.rows) {
                let mut row_dirty = false;
                ffi::ghostty_render_state_row_get(
                    vt.rows,
                    ffi::GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
                    (&raw mut row_dirty).cast(),
                );
                if full || row_dirty {
                    ffi::ghostty_render_state_row_get(
                        vt.rows,
                        ffi::GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
                        (&raw mut vt.cells).cast(),
                    );
                    let line = draw_row(
                        &c,
                        &layout,
                        &self.fonts,
                        vt.cells,
                        f64::from(y) * ch,
                        f64::from(w),
                        bg,
                        fg,
                    );
                    let i = usize::from(y);
                    if self.lines.len() <= i {
                        self.lines.resize(i + 1, Vec::new());
                    }
                    self.lines[i] = line;
                }
                y += 1;
            }
            ffi::ghostty_render_state_clean(vt.rs);
        }
        drop(c);
        cr.set_source_rgb(bg.0, bg.1, bg.2);
        let _ = cr.paint();
        cr.translate(self.pad.0, self.pad.1);
        let _ = cr.set_source_surface(&surface, 0.0, 0.0);
        let _ = cr.paint();
        if let Some(((c0, r0), (c1, r1))) = self.ordered_sel() {
            cr.set_source_rgba(fg.0, fg.1, fg.2, 0.28);
            for r in r0..=r1 {
                let from = if r == r0 { c0 } else { 0 };
                let to = if r == r1 { c1 + 1 } else { self.cols };
                cr.rectangle(
                    f64::from(from) * cw,
                    f64::from(r) * ch,
                    f64::from(to.saturating_sub(from)) * cw,
                    ch,
                );
            }
            let _ = cr.fill();
        }
        if let Some((r, c0, c1, _)) = &self.link {
            cr.set_source_rgb(fg.0, fg.1, fg.2);
            cr.rectangle(
                f64::from(*c0) * cw,
                f64::from(*r) * ch + self.fonts.ascent + 1.0,
                f64::from(c1 - c0) * cw,
                1.0,
            );
            let _ = cr.fill();
        }
        if cursor.visible && cursor.viewport_has_value {
            let (x, y) = (
                f64::from(cursor.viewport_x) * cw,
                f64::from(cursor.viewport_y) * ch,
            );
            let col = if colors.cursor_has_value {
                rgb(colors.cursor)
            } else {
                fg
            };
            cr.set_source_rgba(col.0, col.1, col.2, 0.75);
            match (self.focused, cursor.visual_style) {
                (false, _) | (_, ffi::GHOSTTY_CURSOR_STYLE_BLOCK_HOLLOW) => {
                    cr.set_line_width(1.0);
                    cr.rectangle(x + 0.5, y + 0.5, cw - 1.0, ch - 1.0);
                    let _ = cr.stroke();
                }
                (_, ffi::GHOSTTY_CURSOR_STYLE_BAR) => cr.rectangle(x, y, 2.0, ch),
                (_, ffi::GHOSTTY_CURSOR_STYLE_UNDERLINE) => cr.rectangle(x, y + ch - 2.0, cw, 2.0),
                _ => cr.rectangle(x, y, cw, ch),
            }
            let _ = cr.fill();
        }
        cr.translate(-self.pad.0, -self.pad.1);
        if let Some(t) = self.echo_of.take() {
            wl_stamp("probe-drawn");
            self.samples.push(t.elapsed().as_secs_f64() * 1000.0);
            let mut s = self.samples.clone();
            s.sort_by(f64::total_cmp);
            let pct = |p: f64| s[((s.len() - 1) as f64 * p) as usize];
            self.hud = format!(
                "key→frame n={} p50={:.1}ms p95={:.1}ms",
                s.len(),
                pct(0.5),
                pct(0.95)
            );
            if s.len() % 20 == 0 {
                eprintln!("native-term {}", self.hud);
            }
        }
        if !self.hud.is_empty()
            && (std::env::var_os("TRAME_NATIVE_TERM_HUD").is_some()
                || std::env::var_os("TRAME_NATIVE_TERM_PROBE").is_some())
        {
            layout_hud(cr, w, &self.hud);
        }
        if self.exited {
            layout_hud(cr, w, "[process exited]");
        }
    }
}

fn layout_hud(cr: &cairo::Context, width: i32, text: &str) {
    let layout = pangocairo::functions::create_layout(cr);
    layout.set_font_description(Some(&pango::FontDescription::from_string("Sans 8")));
    layout.set_text(text);
    let (_, logical) = layout.pixel_extents();
    let x = f64::from(width - logical.width() - 8);
    cr.set_source_rgba(0.0, 0.0, 0.0, 0.6);
    cr.rectangle(
        x - 4.0,
        2.0,
        f64::from(logical.width() + 8),
        f64::from(logical.height() + 4),
    );
    let _ = cr.fill();
    cr.set_source_rgb(0.9, 0.9, 0.5);
    cr.move_to(x, 4.0);
    pangocairo::functions::show_layout(cr, &layout);
}

unsafe fn cell_get<T>(
    cells: ffi::GhosttyRenderStateRowCells,
    kind: ffi::GhosttyRenderStateRowCellsData,
    out: &mut T,
) -> bool {
    unsafe {
        ffi::ghostty_render_state_row_cells_get(cells, kind, (out as *mut T).cast())
            == ffi::GHOSTTY_SUCCESS
    }
}

unsafe fn draw_row(
    c: &cairo::Context,
    layout: &pango::Layout,
    fonts: &Fonts,
    cells: ffi::GhosttyRenderStateRowCells,
    top: f64,
    width: f64,
    bg: Rgb,
    fg: Rgb,
) -> Vec<String> {
    let cw = fonts.cw;
    let mut line = Vec::new();
    c.set_source_rgb(bg.0, bg.1, bg.2);
    c.rectangle(0.0, top, width, fonts.ch);
    let _ = c.fill();
    let mut runs: Vec<Run> = Vec::new();
    let mut x = 0u16;
    let mut cps = [0u32; 16];
    while unsafe { ffi::ghostty_render_state_row_cells_next(cells) } {
        let mut len = 0u32;
        let mut style: ffi::GhosttyStyle = unsafe { std::mem::zeroed() };
        let (mut cfg, mut cbg) = (
            ffi::GhosttyColorRgb { r: 0, g: 0, b: 0 },
            ffi::GhosttyColorRgb { r: 0, g: 0, b: 0 },
        );
        unsafe {
            cell_get(
                cells,
                ffi::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
                &mut len,
            );
            cell_get(
                cells,
                ffi::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
                &mut style,
            );
        }
        let mut cell_fg = if unsafe {
            cell_get(
                cells,
                ffi::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
                &mut cfg,
            )
        } {
            rgb(cfg)
        } else {
            fg
        };
        let mut cell_bg = unsafe {
            cell_get(
                cells,
                ffi::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
                &mut cbg,
            )
        }
        .then(|| rgb(cbg));
        if style.flags & INVERSE != 0 {
            (cell_fg, cell_bg) = (cell_bg.unwrap_or(bg), Some(cell_fg));
        }
        if let Some(b) = cell_bg {
            c.set_source_rgb(b.0, b.1, b.2);
            c.rectangle(f64::from(x) * cw, top, cw, fonts.ch);
            let _ = c.fill();
        }
        if style.flags & FAINT != 0 {
            cell_fg = (
                (cell_fg.0 + bg.0) / 2.0,
                (cell_fg.1 + bg.1) / 2.0,
                (cell_fg.2 + bg.2) / 2.0,
            );
        }
        let face =
            usize::from(style.flags & BOLD != 0) | (usize::from(style.flags & ITALIC != 0) << 1);
        let deco = (
            (style.flags & UNDERLINE_MASK) >> 8,
            style.flags & STRIKE != 0,
        );
        let text = if len == 0 || style.flags & INVISIBLE != 0 {
            " ".to_owned()
        } else {
            let mut buf = ffi::GhosttyCodepointBuffer {
                ptr: cps.as_mut_ptr(),
                cap: cps.len(),
                len: 0,
            };
            unsafe {
                cell_get(
                    cells,
                    ffi::GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
                    &mut buf,
                )
            };
            cps[..buf.len.min(cps.len())]
                .iter()
                .filter_map(|&cp| char::from_u32(cp))
                .collect()
        };
        line.push(if style.flags & INVISIBLE != 0 {
            " ".to_owned()
        } else {
            text.clone()
        });
        // ASCII joins runs (monospace keeps them on the grid); anything else is drawn at its own cell
        let joins = text.is_ascii()
            && runs.last().is_some_and(|r| {
                r.fg == cell_fg && r.face == face && r.deco == deco && r.text.is_ascii()
            });
        if joins {
            let run = runs.last_mut().unwrap();
            run.text.push_str(&text);
            run.cells += 1;
        } else {
            runs.push(Run {
                x,
                cells: 1,
                text,
                fg: cell_fg,
                face,
                deco,
            });
        }
        x += 1;
    }
    for run in runs {
        if run.deco != (0, false) {
            let (x0, w) = (f64::from(run.x) * cw, f64::from(run.cells) * cw);
            c.set_source_rgb(run.fg.0, run.fg.1, run.fg.2);
            if run.deco.0 != 0 {
                c.rectangle(x0, top + fonts.ascent + 1.0, w, 1.0);
                if run.deco.0 == 2 {
                    c.rectangle(x0, top + fonts.ascent + 3.0, w, 1.0);
                }
            }
            if run.deco.1 {
                c.rectangle(x0, top + (fonts.ch / 2.0).round(), w, 1.0);
            }
            let _ = c.fill();
        }
        if run.text.trim().is_empty() {
            continue;
        }
        layout.set_font_description(Some(&fonts.faces[run.face]));
        layout.set_text(&run.text);
        c.set_source_rgb(run.fg.0, run.fg.1, run.fg.2);
        c.move_to(f64::from(run.x) * cw, top);
        pangocairo::functions::show_layout(c, layout);
    }
    line
}

/// Wheel rows to the app (mouse protocol or arrows) or to the scrollback.
fn scroll_rows(st: &mut Term, a: &gtk::DrawingArea, rows: f64, at: (f64, f64)) {
    let (up, n) = (rows < 0.0, rows.abs() as usize);
    let screen = (a.allocated_width() as u32, a.allocated_height() as u32);
    let cell = (st.fonts.cw as u32, st.fonts.ch as u32);
    let mut out = Vec::new();
    for _ in 0..n {
        out.extend(st.vt.wheel(up, at, screen, cell));
    }
    if !out.is_empty() {
        st.send(&out); // the app asked for mouse input (Claude Code, vim with mouse)
    } else if st.vt.alt_screen() {
        // full-screen app without mouse input (less, man): arrows, like Ghostty's alternate scroll
        let key = if up {
            ffi::GHOSTTY_KEY_ARROW_UP
        } else {
            ffi::GHOSTTY_KEY_ARROW_DOWN
        };
        for _ in 0..n {
            let bytes = st.vt.encode(key, 0, "", 0);
            st.send(&bytes);
        }
    } else {
        st.vt
            .scroll(ffi::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA, rows as isize);
        st.scrolled = true;
        st.full = true;
        st.sel = None;
    }
}

// Input

fn ghostty_key(key: &gdk::keys::Key) -> (ffi::GhosttyKey, bool) {
    use gdk::keys::constants as k;
    let table = [
        (k::Return, ffi::GHOSTTY_KEY_ENTER),
        (k::KP_Enter, ffi::GHOSTTY_KEY_ENTER),
        (k::BackSpace, ffi::GHOSTTY_KEY_BACKSPACE),
        (k::Tab, ffi::GHOSTTY_KEY_TAB),
        (k::Escape, ffi::GHOSTTY_KEY_ESCAPE),
        (k::Up, ffi::GHOSTTY_KEY_ARROW_UP),
        (k::Down, ffi::GHOSTTY_KEY_ARROW_DOWN),
        (k::Left, ffi::GHOSTTY_KEY_ARROW_LEFT),
        (k::Right, ffi::GHOSTTY_KEY_ARROW_RIGHT),
        (k::Home, ffi::GHOSTTY_KEY_HOME),
        (k::End, ffi::GHOSTTY_KEY_END),
        (k::Page_Up, ffi::GHOSTTY_KEY_PAGE_UP),
        (k::Page_Down, ffi::GHOSTTY_KEY_PAGE_DOWN),
        (k::Delete, ffi::GHOSTTY_KEY_DELETE),
        (k::Insert, ffi::GHOSTTY_KEY_INSERT),
        (k::space, ffi::GHOSTTY_KEY_SPACE),
    ];
    if *key == k::ISO_Left_Tab {
        return (ffi::GHOSTTY_KEY_TAB, true);
    }
    if let Some((_, g)) = table.iter().find(|(gk, _)| gk == key) {
        return (*g, false);
    }
    let f1 = *k::F1;
    if (f1..f1 + 12).contains(&**key) {
        return (ffi::GHOSTTY_KEY_F1 + (**key - f1) as ffi::GhosttyKey, false);
    }
    match key.to_lower().to_unicode() {
        Some(c @ 'a'..='z') => (
            ffi::GHOSTTY_KEY_A + (c as ffi::GhosttyKey - 'a' as ffi::GhosttyKey),
            false,
        ),
        Some(c @ '0'..='9') => (
            ffi::GHOSTTY_KEY_DIGIT_0 + (c as ffi::GhosttyKey - '0' as ffi::GhosttyKey),
            false,
        ),
        _ => (ffi::GHOSTTY_KEY_UNIDENTIFIED, false),
    }
}

/// A native terminal widget running `command` (`sh -c`), or the login shell.
pub fn terminal(command: Option<&str>) -> gtk::Widget {
    terminal_with(command, &Look::default())
}

/// A native terminal with the web terminal's look, running its own shell.
pub fn terminal_with(command: Option<&str>, look: &Look) -> gtk::Widget {
    let (cols, rows) = (80, 24);
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");
    let mut cmd = match command {
        Some(c) => {
            let mut b = CommandBuilder::new("sh");
            b.args(["-c", c]);
            b
        }
        None => CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())),
    };
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).expect("spawn shell");
    drop(pair.slave);
    let fd: RawFd = pair.master.as_raw_fd().expect("pty fd");
    unsafe {
        libc::fcntl(
            fd,
            libc::F_SETFL,
            libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK,
        )
    };
    let writer = pair.master.take_writer().expect("pty writer");
    let (area, state) = build(
        look,
        Io::Pty {
            master: pair.master,
            writer,
        },
    );
    // keep the child handle alive with the widget
    let child = RefCell::new(child);
    // the pty is read on the main loop, like VTE and Konsole: no thread hop between bytes and frame
    let s = state;
    let a = area.clone();
    glib::source::unix_fd_add_local(
        fd,
        glib::IOCondition::IN | glib::IOCondition::HUP | glib::IOCondition::ERR,
        move |_, _| {
            let mut buf = vec![0u8; 1 << 16];
            let mut total = 0usize;
            let mut done = false;
            loop {
                let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                if n > 0 {
                    ingest(&mut s.borrow_mut(), &a, &buf[..n as usize]);
                    total += n as usize;
                    if total >= 1 << 20 {
                        break; // let a frame through during floods
                    }
                } else if n < 0
                    && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock
                {
                    break;
                } else {
                    done = true;
                    break;
                }
            }
            if done {
                s.borrow_mut().exited = true;
                let _ = child.borrow_mut().try_wait();
                a.queue_draw();
                return glib::ControlFlow::Break;
            }
            glib::ControlFlow::Continue
        },
    );
    area.upcast()
}

/// Feed output: parse, answer queries, schedule a frame.
fn ingest(st: &mut Term, a: &gtk::DrawingArea, bytes: &[u8]) {
    st.vt.write(bytes);
    st.flush_replies();
    a.queue_draw();
    if let Some(t) = st.key_at.take() {
        st.echo_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        st.echo_of = Some(t);
    }
}

/// With WAYLAND_DEBUG, a probe event stamped like libwayland's debug lines (UTC wall clock).
fn wl_stamp(what: &str) {
    if std::env::var_os("WAYLAND_DEBUG").is_none() {
        return;
    }
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let s = d.as_secs() % 86_400;
    eprintln!(
        "[{:02}:{:02}:{:02}.{:06}] {what}",
        s / 3600,
        s / 60 % 60,
        s % 60,
        d.subsec_micros()
    );
}

/// A native pane over a shell owned elsewhere: feed it output, it calls back with input and size.
pub struct Pane {
    area: gtk::DrawingArea,
    state: Rc<RefCell<Term>>,
}

impl Pane {
    pub fn new(look: &Look, input: Box<dyn Fn(&[u8])>, resize: Box<dyn Fn(u16, u16)>) -> Self {
        let (area, state) = build(look, Io::Remote { input, resize });
        Self { area, state }
    }

    pub fn widget(&self) -> gtk::Widget {
        self.area.clone().upcast()
    }

    pub fn feed(&self, bytes: &[u8]) {
        ingest(&mut self.state.borrow_mut(), &self.area, bytes);
    }

    /// Paste text as the clipboard shortcut would.
    pub fn paste(&self, text: &str) {
        self.state.borrow_mut().paste(text);
    }

    pub fn exited(&self) {
        self.state.borrow_mut().exited = true;
        self.area.queue_draw();
    }

    /// Hear about image paths hovered and clicked in the pane.
    pub fn on_link(&self, f: Box<dyn Fn(LinkEvent)>) {
        self.state.borrow_mut().on_link = Some(f);
    }

    /// Darken the pane like the page's modal backdrop (0 = none).
    pub fn set_dim(&self, alpha: f64) {
        let mut st = self.state.borrow_mut();
        if (st.dim - alpha).abs() > f64::EPSILON {
            st.dim = alpha;
            self.area.queue_draw();
        }
    }

    /// Leave these pane-local rectangles to whatever is under the pane: no drawing, no input.
    pub fn set_mask(&self, rects: &[cairo::RectangleInt]) {
        let (w, h) = (
            self.area.allocated_width().max(1),
            self.area.allocated_height().max(1),
        );
        let region = cairo::Region::create_rectangle(&cairo::RectangleInt::new(0, 0, w, h));
        for r in rects {
            let _ = region.subtract_rectangle(r);
        }
        if let Some(win) = self.area.window() {
            #[allow(deprecated)]
            win.set_background_pattern(None);
            win.input_shape_combine_region(&region, 0, 0);
        }
        self.state.borrow_mut().clip = (!rects.is_empty()).then_some(region);
        self.area.queue_draw();
    }
}

/// The widget and its state, with drawing, keys, wheel and focus wired.
fn build(look: &Look, io: Io) -> (gtk::DrawingArea, Rc<RefCell<Term>>) {
    let area = gtk::DrawingArea::new();
    area.set_can_focus(true);
    area.add_events(
        gdk::EventMask::KEY_PRESS_MASK
            | gdk::EventMask::BUTTON_PRESS_MASK
            | gdk::EventMask::BUTTON_RELEASE_MASK
            | gdk::EventMask::POINTER_MOTION_MASK
            | gdk::EventMask::LEAVE_NOTIFY_MASK
            | gdk::EventMask::SCROLL_MASK
            | gdk::EventMask::SMOOTH_SCROLL_MASK
            | gdk::EventMask::FOCUS_CHANGE_MASK,
    );
    let fonts = Fonts::new(&area.pango_context(), &look.family, look.px);
    let (cols, rows) = (80, 24);
    let state = Rc::new(RefCell::new(Term {
        vt: {
            let mut vt = Vt::new(cols, rows);
            vt.style(&look.theme);
            vt
        },
        io,
        fonts,
        cols,
        rows,
        cache: None,
        focused: false,
        exited: false,
        full: false,
        pad: look.pad,
        key_at: None,
        echo_of: None,
        samples: Vec::new(),
        hud: String::new(),
        clip: None,
        dim: 0.0,
        lines: Vec::new(),
        sel: None,
        dragging: false,
        scrolled: false,
        link: None,
        on_link: None,
        draw_ms: Vec::new(),
        paint_ms: Vec::new(),
        echo_ms: Vec::new(),
    }));

    let s = state.clone();
    area.connect_draw(move |a, cr| {
        if let Some(region) = &s.borrow().clip {
            for i in 0..region.num_rectangles() {
                let r = region.rectangle(i);
                cr.rectangle(
                    f64::from(r.x()),
                    f64::from(r.y()),
                    f64::from(r.width()),
                    f64::from(r.height()),
                );
            }
            cr.clip();
        }
        let t0 = Instant::now();
        s.borrow_mut().draw(a, cr);
        s.borrow_mut()
            .draw_ms
            .push(t0.elapsed().as_secs_f64() * 1000.0);
        let dim = s.borrow().dim;
        if dim > 0.0 {
            cr.set_source_rgba(0.0, 0.0, 0.0, dim);
            let _ = cr.paint();
        }
        glib::Propagation::Stop
    });
    let s = state.clone();
    area.connect_size_allocate(move |_, alloc| {
        s.borrow_mut().resize(alloc.width(), alloc.height())
    });

    // TRAME_NATIVE_TERM_PROBE=n types n characters into the shell and times each echo to its frame
    if let Some(n) = std::env::var("TRAME_NATIVE_TERM_PROBE")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
    {
        let s = state.clone();
        let a = area.clone();
        let mut sent = 0u32;
        let delay = std::env::var("TRAME_NATIVE_TERM_PROBE_DELAY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        glib::timeout_add_local_once(std::time::Duration::from_secs(delay), move || {
            // uneven 40–120ms gaps so the keys don't phase-lock to vsync
            let mut wait = 0u32;
            let s2 = s.clone();
            if let Some(clock) = a.frame_clock() {
                let start = Rc::new(std::cell::Cell::new(None::<Instant>));
                let st0 = start.clone();
                clock.connect_before_paint(move |_| st0.set(Some(Instant::now())));
                let s3 = s2.clone();
                clock.connect_after_paint(move |_| {
                    if let Some(t) = start.take() {
                        s3.borrow_mut()
                            .paint_ms
                            .push(t.elapsed().as_secs_f64() * 1000.0);
                    }
                });
            }
            glib::timeout_add_local(std::time::Duration::from_millis(4), move || {
                if wait > 0 {
                    wait -= 1;
                    return glib::ControlFlow::Continue;
                }
                wait = 10 + (sent.wrapping_mul(2_654_435_761) >> 7) % 20;
                sent += 1;
                let mut st = s.borrow_mut();
                if sent > n {
                    st.send(b"\x15"); // ctrl-u: drop the probe line
                    let mut d = st.draw_ms.clone();
                    d.sort_by(f64::total_cmp);
                    let at = |p: f64| {
                        d.get(((d.len().max(1) - 1) as f64 * p) as usize)
                            .copied()
                            .unwrap_or(0.0)
                    };
                    let mut e = st.echo_ms.clone();
                    e.sort_by(f64::total_cmp);
                    let ea = |p: f64| {
                        e.get(((e.len().max(1) - 1) as f64 * p) as usize)
                            .copied()
                            .unwrap_or(0.0)
                    };
                    let mut pm = st.paint_ms.clone();
                    pm.sort_by(f64::total_cmp);
                    let pa = |p: f64| {
                        pm.get(((pm.len().max(1) - 1) as f64 * p) as usize)
                            .copied()
                            .unwrap_or(0.0)
                    };
                    eprintln!(
                        "native-term probe paint: {}x{} n={} p50={:.1}ms p95={:.1}ms",
                        st.cols,
                        st.rows,
                        pm.len(),
                        pa(0.5),
                        pa(0.95)
                    );
                    eprintln!(
                        "native-term probe done: {} | echo p50={:.1}ms p95={:.1}ms | draw n={} p50={:.1}ms p95={:.1}ms max={:.1}ms",
                        st.hud,
                        ea(0.5),
                        ea(0.95),
                        d.len(),
                        at(0.5),
                        at(0.95),
                        at(1.0)
                    );
                    return glib::ControlFlow::Break;
                }
                st.key_at = Some(Instant::now());
                wl_stamp("probe-key");
                st.send(b"x");
                glib::ControlFlow::Continue
            });
        });
    }

    // test hook: TRAME_NATIVE_TERM_TEST_SCROLL=n scrolls up n rows after 1s
    if let Some(n) = std::env::var("TRAME_NATIVE_TERM_TEST_SCROLL")
        .ok()
        .and_then(|v| v.parse::<isize>().ok())
    {
        let s = state.clone();
        let a = area.clone();
        glib::timeout_add_local_once(std::time::Duration::from_secs(1), move || {
            scroll_rows(&mut s.borrow_mut(), &a, -(n as f64), (10.0, 10.0));
            a.queue_draw();
        });
    }

    let s = state.clone();
    area.connect_key_press_event(move |a, ev| {
        let mut st = s.borrow_mut();
        let key = ev.keyval();
        let m = ev.state();
        let (ctrl, shift, alt) = (
            m.contains(gdk::ModifierType::CONTROL_MASK),
            m.contains(gdk::ModifierType::SHIFT_MASK),
            m.contains(gdk::ModifierType::MOD1_MASK),
        );
        if ctrl && shift && key.to_lower() == gdk::keys::constants::v {
            if let Some(text) = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD).wait_for_text() {
                st.paste(&text);
            }
            return glib::Propagation::Stop;
        }
        let (gkey, forced_shift) = ghostty_key(&key);
        let mut mods = 0u16;
        if shift || forced_shift {
            mods |= ffi::GHOSTTY_MODS_SHIFT as u16;
        }
        if ctrl {
            mods |= ffi::GHOSTTY_MODS_CTRL as u16;
        }
        if alt {
            mods |= ffi::GHOSTTY_MODS_ALT as u16;
        }
        let text: String = key
            .to_unicode()
            .filter(|c| !c.is_control())
            .map(String::from)
            .unwrap_or_default();
        let unshifted = key.to_lower().to_unicode().map_or(0, u32::from);
        let bytes = st.vt.encode(gkey, mods, &text, unshifted);
        if bytes.is_empty() {
            return glib::Propagation::Proceed;
        }
        // no frame for the key itself: a frame now would hold the echo's frame back by one on Wayland
        if st.scrolled || st.sel.is_some() {
            st.vt
                .scroll(ffi::GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM, 0);
            st.scrolled = false;
            st.full = true;
            st.sel = None;
            a.queue_draw();
        }
        st.key_at = Some(Instant::now());
        st.send(&bytes);
        glib::Propagation::Stop
    });
    let s = state.clone();
    // touchpads send fractional smooth deltas: accumulate them into whole rows
    let pending = std::cell::Cell::new(0.0f64);
    area.connect_scroll_event(move |a, ev| {
        let dy = match ev.direction() {
            gdk::ScrollDirection::Up => -3.0,
            gdk::ScrollDirection::Down => 3.0,
            gdk::ScrollDirection::Smooth => ev.delta().1 * 3.0,
            _ => 0.0,
        };
        let total = pending.get() + dy;
        let rows = total.trunc();
        pending.set(total - rows);
        if rows != 0.0 {
            let mut st = s.borrow_mut();
            let (x, y) = ev.position();
            let pad = st.pad;
            scroll_rows(&mut st, a, rows, (x - pad.0, y - pad.1));
            a.queue_draw();
        }
        glib::Propagation::Stop
    });
    // left drag selects (and copies on release, like a Linux terminal); a click on an image path opens it
    let s = state.clone();
    area.connect_button_press_event(move |a, ev| {
        a.grab_focus();
        if ev.button() != 1 || ev.event_type() != gdk::EventType::ButtonPress {
            return glib::Propagation::Stop;
        }
        let (x, y) = ev.position();
        let mut st = s.borrow_mut();
        let cell = st.cell_at(x, y);
        st.sel = Some((cell, cell));
        st.dragging = true;
        a.queue_draw();
        glib::Propagation::Stop
    });
    let s = state.clone();
    area.connect_motion_notify_event(move |a, ev| {
        let (x, y) = ev.position();
        let mut st = s.borrow_mut();
        let cell = st.cell_at(x, y);
        if st.dragging {
            if let Some((anchor, _)) = st.sel {
                st.sel = Some((anchor, cell));
                a.queue_draw();
            }
            return glib::Propagation::Stop;
        }
        let found = st.link_at(cell.0, cell.1);
        let same = match (&found, &st.link) {
            (Some((c0, _, p)), Some((r, l0, _, q))) => *r == cell.1 && c0 == l0 && p == q,
            (None, None) => true,
            _ => false,
        };
        if same {
            return glib::Propagation::Stop;
        }
        st.link = found.map(|(c0, c1, p)| (cell.1, c0, c1, p));
        let pointer = if st.link.is_some() { "pointer" } else { "text" };
        if let Some(w) = a.window() {
            w.set_cursor(gdk::Cursor::from_name(&a.display(), pointer).as_ref());
        }
        let event = st
            .link
            .as_ref()
            .map_or(LinkEvent::Leave, |(_, _, _, p)| LinkEvent::Hover {
                path: p.clone(),
                x,
                y,
            });
        if let Some(f) = &st.on_link {
            f(event);
        }
        a.queue_draw();
        glib::Propagation::Stop
    });
    let s = state.clone();
    area.connect_button_release_event(move |a, ev| {
        if ev.button() != 1 {
            return glib::Propagation::Stop;
        }
        let mut st = s.borrow_mut();
        st.dragging = false;
        if let Some(text) = st.selection_text().filter(|t| !t.is_empty()) {
            for sel in [gdk::SELECTION_CLIPBOARD, gdk::SELECTION_PRIMARY] {
                gtk::Clipboard::get(&sel).set_text(&text);
            }
        } else {
            st.sel = None;
            if let (Some((_, _, _, path)), Some(f)) = (&st.link, &st.on_link) {
                let (x, y) = ev.position();
                f(LinkEvent::Open {
                    path: path.clone(),
                    x,
                    y,
                });
            }
        }
        a.queue_draw();
        glib::Propagation::Stop
    });
    let s = state.clone();
    area.connect_leave_notify_event(move |a, _| {
        let mut st = s.borrow_mut();
        if !st.dragging && st.link.take().is_some() {
            if let Some(f) = &st.on_link {
                f(LinkEvent::Leave);
            }
            a.queue_draw();
        }
        glib::Propagation::Proceed
    });
    let s = state.clone();
    area.connect_focus_in_event(move |a, _| {
        s.borrow_mut().focused = true;
        a.queue_draw();
        glib::Propagation::Proceed
    });
    let s = state.clone();
    area.connect_focus_out_event(move |a, _| {
        s.borrow_mut().focused = false;
        a.queue_draw();
        glib::Propagation::Proceed
    });
    (area, state)
}

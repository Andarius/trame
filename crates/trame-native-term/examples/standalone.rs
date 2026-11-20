// A bare GTK window holding one native terminal: `cargo run -p trame-native-term --example standalone [-- 'cmd']`.
#[cfg(target_os = "linux")]
fn main() {
    use gtk::prelude::*;
    gtk::init().expect("gtk init");
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("trame native terminal");
    window.set_default_size(1000, 650);
    let command = std::env::args().nth(1);
    let term = trame_native_term::terminal(command.as_deref());
    window.add(&term);
    window.connect_destroy(|_| gtk::main_quit());
    window.show_all();
    term.grab_focus();
    gtk::main();
}

#[cfg(not(target_os = "linux"))]
fn main() {}

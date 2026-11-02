use std::ffi::{OsStr, OsString};

// the AppImage runtime's variables, which point programs at the mounted image
const APPIMAGE_ENV: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "LD_LIBRARY_PATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "GTK_PATH",
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GTK_THEME",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "QT_PLUGIN_PATH",
];

// path lists the runtime prefixes with entries under the image
const PATH_LISTS: &[&str] = &["PATH", "XDG_DATA_DIRS"];

/// The env changes that give a child the host's environment: `None` removes the variable.
pub fn host_env() -> Vec<(&'static str, Option<OsString>)> {
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return Vec::new();
    };
    let removed = APPIMAGE_ENV.iter().map(|key| (*key, None));
    let lists = PATH_LISTS.iter().filter_map(|key| {
        let value = std::env::var_os(key)?;
        Some((*key, Some(without_image(&value, &appdir))))
    });
    removed.chain(lists).collect()
}

/// A path list without the entries under the mounted image (`appdir`).
fn without_image(list: &OsStr, appdir: &OsStr) -> OsString {
    let kept = std::env::split_paths(list).filter(|p| !p.starts_with(appdir));
    std::env::join_paths(kept).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_image_drops_the_mounted_image() {
        let path = OsStr::new("/tmp/.mount_X/usr/bin:/home/u/.cargo/bin:/usr/bin");
        assert_eq!(
            without_image(path, OsStr::new("/tmp/.mount_X")),
            "/home/u/.cargo/bin:/usr/bin"
        );
    }
}

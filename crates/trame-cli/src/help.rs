use serde_json::Value;
use std::sync::LazyLock;

static HELP: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("help.json")).expect("generated help"));
static OVERVIEW: LazyLock<String> = LazyLock::new(|| {
    HELP["OVERVIEW"].as_str().unwrap().replacen(
        &format!("tramecli {}", env!("CARGO_PKG_VERSION")),
        &format!("tramecli {}", version()),
        1,
    )
});
pub fn topic(name: &str) -> &'static str {
    if name == "OVERVIEW" {
        return &OVERVIEW;
    }
    HELP[name].as_str().unwrap_or(&OVERVIEW)
}
pub fn version() -> String {
    let release = env!("CARGO_PKG_VERSION");
    match option_env!("TRAME_BUILD") {
        Some(build) if !build.is_empty() => format!("{release}+{build}"),
        _ => release.to_owned(),
    }
}

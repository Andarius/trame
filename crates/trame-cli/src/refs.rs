use regex::Regex;
use reqwest::Url;
use std::sync::LazyLock;

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefKind {
    Session,
    Page,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub kind: RefKind,
    pub id: String,
}
pub fn parse_session_ref(input: &str) -> Option<SessionRef> {
    let input = input.trim();
    if UUID.is_match(input) {
        return Some(SessionRef {
            kind: RefKind::Session,
            id: input.into(),
        });
    }
    let url = Url::parse(input).ok()?;
    for (key, kind) in [
        ("card", RefKind::Session),
        ("session", RefKind::Session),
        ("page", RefKind::Page),
    ] {
        if let Some((_, id)) = url.query_pairs().find(|(name, _)| name == key) {
            if UUID.is_match(&id) {
                return Some(SessionRef {
                    kind,
                    id: id.into_owned(),
                });
            }
        }
    }
    None
}

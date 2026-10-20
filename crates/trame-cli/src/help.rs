use std::{collections::HashMap, sync::LazyLock};

// `%%NAME%%` in a topic inlines another topic (or the version), so shared text has one source
const SOURCES: &[(&str, &str)] = &[
    ("ARCHIVE_HELP", include_str!("help/ARCHIVE_HELP.md")),
    ("CAPABILITIES", include_str!("help/CAPABILITIES.md")),
    ("COMMENT_HELP", include_str!("help/COMMENT_HELP.md")),
    ("CONVERT_HELP", include_str!("help/CONVERT_HELP.md")),
    ("DEPLOYMENTS_HELP", include_str!("help/DEPLOYMENTS_HELP.md")),
    ("GRAPH_FENCE", include_str!("help/GRAPH_FENCE.md")),
    ("LIST_HELP", include_str!("help/LIST_HELP.md")),
    ("MOVE_HELP", include_str!("help/MOVE_HELP.md")),
    ("OPEN_HELP", include_str!("help/OPEN_HELP.md")),
    ("OVERVIEW", include_str!("help/OVERVIEW.md")),
    ("PAGE_DIALECT", include_str!("help/PAGE_DIALECT.md")),
    ("PAGE_HELP", include_str!("help/PAGE_HELP.md")),
    ("PRESENCE_HELP", include_str!("help/PRESENCE_HELP.md")),
    ("QUERY_SYNTAX", include_str!("help/QUERY_SYNTAX.md")),
    ("SETUP_HELP", include_str!("help/SETUP_HELP.md")),
    ("SHOW_HELP", include_str!("help/SHOW_HELP.md")),
    ("SPECS_WHEN", include_str!("help/SPECS_WHEN.md")),
    ("STORIES_HELP", include_str!("help/STORIES_HELP.md")),
    ("TODO_SYNTAX", include_str!("help/TODO_SYNTAX.md")),
    ("TRACK_FIELDS", include_str!("help/TRACK_FIELDS.md")),
    ("TRACK_HELP", include_str!("help/TRACK_HELP.md")),
    ("UDB_CONTRACT", include_str!("help/UDB_CONTRACT.md")),
];

static TOPICS: LazyLock<HashMap<&'static str, String>> = LazyLock::new(|| {
    let raw: HashMap<&str, &str> = SOURCES
        .iter()
        .map(|(name, text)| (*name, text.strip_suffix('\n').unwrap_or(text)))
        .collect();
    raw.keys().map(|name| (*name, expand(&raw, name))).collect()
});

fn expand(raw: &HashMap<&str, &str>, name: &str) -> String {
    let mut out = String::new();
    let mut rest = raw[name];
    while let Some(start) = rest.find("%%") {
        let (before, tail) = rest.split_at(start);
        let end = tail[2..].find("%%").expect("unterminated %% placeholder") + 2;
        let key = &tail[2..end];
        out.push_str(before);
        if key == "VERSION" {
            out.push_str(&version());
        } else {
            out.push_str(&expand(raw, key));
        }
        rest = &tail[end + 2..];
    }
    out.push_str(rest);
    out
}

pub fn topic(name: &str) -> &'static str {
    TOPICS.get(name).unwrap_or(&TOPICS["OVERVIEW"])
}
pub fn version() -> String {
    let release = env!("CARGO_PKG_VERSION");
    match option_env!("TRAME_BUILD") {
        Some(build) if !build.is_empty() => format!("{release}+{build}"),
        _ => release.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_topic_expands_fully() {
        for (name, _) in SOURCES {
            let text = topic(name);
            assert!(!text.contains("%%"), "{name} has an unexpanded placeholder");
            assert!(!text.ends_with('\n'), "{name} keeps its trailing newline");
        }
        assert!(topic("OVERVIEW").starts_with(&format!("tramecli {} ", version())));
    }
}

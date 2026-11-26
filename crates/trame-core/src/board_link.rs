/// `("board", query)` for `trame://board?q=<query>`, `("view", name)` for `trame://view/<name>`.
pub fn parse(url: &str) -> Option<(&'static str, String)> {
    let rest = url.trim().strip_prefix("trame://")?;
    let rest = rest.split('#').next().unwrap_or_default();
    let (path, search) = rest.split_once('?').unwrap_or((rest, ""));
    let path = path.trim_end_matches('/');
    if path == "board" {
        let q = search
            .split('&')
            .find_map(|pair| pair.strip_prefix("q="))
            .map(|v| decode(&v.replace('+', " ")))
            .unwrap_or_default();
        return Some(("board", crate::trim(&q).to_owned()));
    }
    let raw = path.strip_prefix("view/").filter(|r| !r.contains('/'))?;
    let name = decode(raw);
    let name = crate::trim(&name);
    (!name.is_empty()).then(|| ("view", name.to_owned()))
}

/// The `trame://` link for a board query or a saved view name.
pub fn link(kind: &str, target: &str) -> String {
    if kind == "view" {
        format!("trame://view/{}", encode(target))
    } else {
        format!("trame://board?q={}", encode(target))
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%')
            .then(|| text.get(i + 1..i + 3))
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        out.push(hex.unwrap_or(bytes[i]));
        i += if hex.is_some() { 3 } else { 1 };
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The compact UUID in a local agent run link.
pub fn valid_run_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_board_and_view_links() {
        for (url, expected) in [
            (
                "trame://board?q=tag%3Aparked",
                Some(("board", "tag:parked")),
            ),
            (
                "trame://board/?q=status:active+project:trame",
                Some(("board", "status:active project:trame")),
            ),
            (
                "trame://board?x=1&q=%22a%20b%22#top",
                Some(("board", "\"a b\"")),
            ),
            ("trame://board", Some(("board", ""))),
            ("trame://view/Parked", Some(("view", "Parked"))),
            ("trame://view/My%20views/", Some(("view", "My views"))),
            ("trame://view/C++", Some(("view", "C++"))),
            ("trame://view/", None),
            ("trame://view/a/b", None),
            ("trame://page/x", None),
            ("https://board?q=x", None),
        ] {
            assert_eq!(
                parse(url),
                expected.map(|(k, v)| (k, v.to_owned())),
                "{url}"
            );
        }
    }

    #[test]
    fn links_round_trip() {
        for (kind, target) in [
            ("board", "tag:parked \"a b\" -x&y+z"),
            ("view", "Mon views/é"),
        ] {
            let url = link(kind, target);
            assert_eq!(
                parse(&url).map(|(_, t)| t),
                Some(target.to_owned()),
                "{url}"
            );
        }
    }
}

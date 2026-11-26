use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::io::{self, Read as _};

pub fn generate() -> io::Result<String> {
    let mut raw = [0; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut raw)?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

pub fn hash(token: &str) -> String {
    crate::assets::hex(&Sha256::digest(token.as_bytes()))
}

use std::io::{self, BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input: Box<dyn BufRead> = match std::env::args().nth(1) {
        Some(path) => Box::new(io::BufReader::new(std::fs::File::open(path)?)),
        None => Box::new(io::BufReader::new(io::stdin())),
    };
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in input.lines() {
        let request = serde_json::from_str(&line?)?;
        let result = trame_core::evaluate_value(&request).map_err(io::Error::other)?;
        writeln!(out, "{result}")?;
    }
    Ok(())
}

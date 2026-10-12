#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "CLI output is the product; stderr is the app log"
)]

#[tokio::main]
#[allow(clippy::exit, reason = "propagates the CLI exit code")]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match trame_cli::cli::run(&args).await {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1)
        }
    }
}

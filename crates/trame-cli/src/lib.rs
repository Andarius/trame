#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "CLI output is the product; stderr is the app log"
)]

pub mod board;
pub mod claude_hook;
pub mod cli;
pub mod comment;
pub mod db;
pub mod deployments;
pub mod due;
pub mod help;
pub mod mcp;
pub mod open;
pub mod page;
pub mod plugin_cmd;
pub mod plugins;
pub mod presence;
pub mod query;
pub mod refs;
pub mod setup;
pub mod target;
pub mod track;
pub mod watch;

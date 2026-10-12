#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "CLI output is the product; stderr is the app log"
)]

fn main() -> anyhow::Result<()> {
    if let Some(result) = trame_local::pg::supervisor_args() {
        return result;
    }
    let mut config = trame_local::Config::from_env()?;
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("migrate") {
        let source = args
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("usage: trame-local migrate SOURCE"))?;
        let source = std::path::Path::new(source).canonicalize()?;
        let root = config.root.clone();
        anyhow::ensure!(
            !root.join("postgres").starts_with(&source)
                && !source.starts_with(root.join("postgres")),
            "migration source and target overlap"
        );
        if trame_local::isolated_mode() {
            config.root = trame_local::scratch_root(&config.root)?;
            trame_local::scratch_path(&source)?;
        }
        return trame_local::pg::migrate(&source, &config.root, &config.pg_bin);
    }
    if trame_local::isolated_mode() {
        config.root = trame_local::scratch_root(&config.root)?;
    }
    tokio::runtime::Runtime::new()?.block_on(async move {
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(trame_local::run(config, ready_tx, stop_rx));
        if ready_rx.await.is_err(){task.await??;anyhow::bail!("backend stopped before readiness");}
        println!("Rust front door ready");
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = &mut task => { result??; return Ok(()); }, _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        let _ = stop_tx.send(());
        task.await??;
        Ok::<_, anyhow::Error>(())
    })
}

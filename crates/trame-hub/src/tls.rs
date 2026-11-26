use anyhow::{Context, Result};
use axum::Router;
use hyper::server::conn::http1;
use hyper_util::{rt::TokioIo, service::TowerToHyperService};
use std::{env, fs::File, io::BufReader, path::PathBuf, sync::Arc, time::Duration};
use tokio::{net::TcpListener, time::timeout};
use tokio_rustls::TlsAcceptor;

fn pem(var: &str, default: &str) -> Result<BufReader<File>> {
    let path = PathBuf::from(env::var_os(var).unwrap_or_else(|| default.into()));
    Ok(BufReader::new(File::open(&path).with_context(|| {
        format!("opening {var} ({})", path.display())
    })?))
}

pub(crate) async fn serve(router: &Router) -> Result<()> {
    let certs = rustls_pemfile::certs(&mut pem("TRACKER_API_CERT", "/certs/server.crt")?)
        .collect::<std::io::Result<_>>()?;
    let key = rustls_pemfile::private_key(&mut pem("TRACKER_API_KEY", "/certs/server.key")?)?
        .context("server private key missing")?;
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(certs, key)?;
    let acceptor = TlsAcceptor::from(Arc::new(tls));
    let port: u16 = env::var("PORT").unwrap_or_else(|_| "8443".into()).parse()?;
    let host = env::var("TRACKER_API_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let listener = TcpListener::bind((host.as_str(), port)).await?;
    loop {
        let (stream, _) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            if let Ok(Ok(stream)) = timeout(Duration::from_secs(10), acceptor.accept(stream)).await
            {
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            }
        });
    }
}

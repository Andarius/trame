//! The HTTP transport: `POST /v1/connector/{hello,poll,acks,events}` with a machine's bearer token.

use std::{env, time::Duration};

use anyhow::{Context, Result, ensure};
use axum::http::StatusCode;
use reqwest::{Client, Url};
use serde::Serialize;

use super::protocol::{Ack, Acks, Deliveries, Delivery, Event, Events, Hello, Poll};
use crate::agent::runner::{Failure, Transport};

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "served by `tramecli connector serve`, the next step"
    )
)]
pub(crate) mod server {
    use std::{collections::HashMap, sync::Arc};

    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, StatusCode, header::AUTHORIZATION},
        response::{IntoResponse, Response},
        routing::post,
    };
    use serde_json::json;

    use super::super::{
        Connector, Refusal,
        protocol::{Acks, Deliveries, Events, Hello, Poll},
    };

    /// Machine token → machine name; fixed by the caller until pairing exists.
    pub(crate) type Tokens = HashMap<String, String>;

    type Shared = (Arc<Connector>, Arc<Tokens>);

    pub(crate) fn router(connector: Arc<Connector>, tokens: Tokens) -> Router {
        Router::new()
            .route("/v1/connector/hello", post(hello))
            .route("/v1/connector/poll", post(poll))
            .route("/v1/connector/acks", post(acks))
            .route("/v1/connector/events", post(events))
            .with_state((connector, Arc::new(tokens)))
    }

    fn machine(tokens: &Tokens, headers: &HeaderMap) -> Option<String> {
        headers
            .get(AUTHORIZATION)
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .and_then(|token| tokens.get(token))
            .cloned()
    }

    fn unknown() -> Response {
        refused(StatusCode::UNAUTHORIZED, "unknown machine token")
    }

    fn refused(status: StatusCode, error: &str) -> Response {
        (status, Json(json!({"error":error}))).into_response()
    }

    fn refusal(refusal: &Refusal) -> Response {
        match refusal {
            Refusal::HelloRequired => refused(StatusCode::CONFLICT, "hello required"),
            Refusal::Version => refused(StatusCode::BAD_REQUEST, "unsupported protocol version"),
            Refusal::Machine => refused(StatusCode::FORBIDDEN, "this token is for another machine"),
        }
    }

    async fn hello(
        State((connector, tokens)): State<Shared>,
        headers: HeaderMap,
        Json(body): Json<Hello>,
    ) -> Response {
        match machine(&tokens, &headers) {
            Some(machine) => match connector.hello(&machine, body) {
                Ok(()) => StatusCode::NO_CONTENT.into_response(),
                Err(e) => refusal(&e),
            },
            None => unknown(),
        }
    }

    async fn poll(
        State((connector, tokens)): State<Shared>,
        headers: HeaderMap,
        Json(body): Json<Poll>,
    ) -> Response {
        match machine(&tokens, &headers) {
            Some(machine) => match connector.poll(&machine, &body.rev).await {
                Ok(deliveries) => Json(Deliveries { deliveries }).into_response(),
                Err(e) => refusal(&e),
            },
            None => unknown(),
        }
    }

    async fn acks(
        State((connector, tokens)): State<Shared>,
        headers: HeaderMap,
        Json(body): Json<Acks>,
    ) -> Response {
        match machine(&tokens, &headers) {
            Some(machine) => {
                connector.acks(&machine, body.acks);
                StatusCode::NO_CONTENT.into_response()
            }
            None => unknown(),
        }
    }

    async fn events(
        State((connector, tokens)): State<Shared>,
        headers: HeaderMap,
        Json(body): Json<Events>,
    ) -> Response {
        match machine(&tokens, &headers) {
            Some(machine) => {
                connector.events(&machine, body.events);
                StatusCode::NO_CONTENT.into_response()
            }
            None => unknown(),
        }
    }
}

/// A runner's side of the HTTP transport.
pub(crate) struct Remote {
    client: Client,
    base: Url,
    token: String,
}

impl Remote {
    pub(crate) fn new(base: &str, token: String) -> Result<Self> {
        let mut base = Url::parse(base).context("TRAME_CONNECTOR_URL is not a URL")?;
        ensure!(
            matches!(base.scheme(), "http" | "https")
                && base.username().is_empty()
                && base.password().is_none(),
            "TRAME_CONNECTOR_URL must be an http(s) URL without credentials"
        );
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        Ok(Self {
            // longer than the connector holds a poll
            client: Client::builder()
                .timeout(Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base,
            token,
        })
    }

    /// The connector in `TRAME_CONNECTOR_URL`, with the token in `TRAME_CONNECTOR_TOKEN_FILE`.
    pub(crate) async fn from_env() -> Result<Option<Self>> {
        let Ok(url) = env::var("TRAME_CONNECTOR_URL") else {
            return Ok(None);
        };
        let token = crate::agent::slack::token("TRAME_CONNECTOR_TOKEN_FILE", "").await?;
        Self::new(&url, token).map(Some)
    }

    async fn post<B: Serialize + Sync>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<reqwest::Response, Failure> {
        let url = self
            .base
            .join(&format!("v1/connector/{path}"))
            .map_err(|e| Failure::Other(e.to_string()))?;
        let response = self
            .client
            .post(url)
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| Failure::Other(format!("connector unreachable: {e}")))?;
        match response.status() {
            StatusCode::CONFLICT => Err(Failure::HelloRequired),
            status if status.is_success() => Ok(response),
            status => Err(Failure::Other(format!("connector answered {status}"))),
        }
    }
}

impl Transport for Remote {
    async fn hello(&self, hello: &Hello) -> Result<(), Failure> {
        self.post("hello", hello).await.map(drop)
    }

    async fn poll(&self, rev: &str) -> Result<Vec<Delivery>, Failure> {
        let response = self.post("poll", &Poll { rev: rev.into() }).await?;
        let body: Deliveries = response
            .json()
            .await
            .map_err(|e| Failure::Other(format!("bad poll reply: {e}")))?;
        Ok(body.deliveries)
    }

    async fn acks(&self, acks: &[Ack]) -> Result<(), Failure> {
        self.post(
            "acks",
            &Acks {
                acks: acks.to_vec(),
            },
        )
        .await
        .map(drop)
    }

    async fn events(&self, events: &[Event]) -> Result<(), Failure> {
        self.post(
            "events",
            &Events {
                events: events.to_vec(),
            },
        )
        .await
        .map(drop)
    }
}

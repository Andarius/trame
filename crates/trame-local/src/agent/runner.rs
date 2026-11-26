//! The runner: the machine side of the bridge. It tells a connector which bots this machine offers,
//! polls for deliveries, starts and stops runs, and reports their status back.

use std::{
    collections::{HashMap, VecDeque},
    future::{Future, ready},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
    time::sleep,
};

use super::bots::Bot;
use super::connector::{
    Connector, Refusal,
    protocol::{Ack, AckState, Delivery, Event, Hello, Kind, Status, VERSION},
};
use super::run::{Provider, Run};

pub(crate) const RETRY: Duration = Duration::from_secs(2);
/// Delivery ids remembered so a redelivery never runs twice.
const SEEN: usize = 512;
const EVENT_ATTEMPTS: usize = 10;

/// The bots this machine offers to Slack, read on each poll (blocking: it reads the database).
pub(crate) type Offered = Arc<dyn Fn() -> Vec<Bot> + Send + Sync>;

#[derive(Debug)]
pub(crate) enum Failure {
    HelloRequired,
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HelloRequired => f.write_str("hello required"),
            Self::Other(reason) => f.write_str(reason),
        }
    }
}

/// How a runner reaches its connector: in process or over HTTP.
pub(crate) trait Transport: Send + Sync + 'static {
    fn hello(&self, hello: &Hello) -> impl Future<Output = Result<(), Failure>> + Send;
    fn poll(&self, rev: &str) -> impl Future<Output = Result<Vec<Delivery>, Failure>> + Send;
    fn acks(&self, acks: &[Ack]) -> impl Future<Output = Result<(), Failure>> + Send;
    fn events(&self, events: &[Event]) -> impl Future<Output = Result<(), Failure>> + Send;
}

/// The connector in this same app: the desktop holds the Slack app.
pub(crate) struct Local {
    connector: Arc<Connector>,
    machine: String,
}

impl Local {
    pub(crate) fn new(connector: Arc<Connector>, machine: String) -> Self {
        Self { connector, machine }
    }
}

impl From<Refusal> for Failure {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::HelloRequired => Self::HelloRequired,
            other => Self::Other(format!("{other:?}")),
        }
    }
}

impl Transport for Local {
    fn hello(&self, hello: &Hello) -> impl Future<Output = Result<(), Failure>> + Send {
        ready(
            self.connector
                .hello(&self.machine, hello.clone())
                .map_err(Failure::from),
        )
    }

    async fn poll(&self, rev: &str) -> Result<Vec<Delivery>, Failure> {
        Ok(self.connector.poll(&self.machine, rev).await?)
    }

    fn acks(&self, acks: &[Ack]) -> impl Future<Output = Result<(), Failure>> + Send {
        self.connector.acks(&self.machine, acks.to_vec());
        ready(Ok(()))
    }

    fn events(&self, events: &[Event]) -> impl Future<Output = Result<(), Failure>> + Send {
        self.connector.events(&self.machine, events.to_vec());
        ready(Ok(()))
    }
}

/// Delivery ids already received, and whether each is done; the oldest are forgotten.
#[derive(Default)]
struct Seen {
    done: HashMap<String, bool>,
    order: VecDeque<String>,
}

impl Seen {
    /// Whether `id` was seen before (and done), remembering it if not.
    fn see(&mut self, id: &str) -> Option<bool> {
        if let Some(done) = self.done.get(id) {
            return Some(*done);
        }
        if self.order.len() >= SEEN
            && let Some(old) = self.order.pop_front()
        {
            self.done.remove(&old);
        }
        self.order.push_back(id.to_owned());
        self.done.insert(id.to_owned(), false);
        None
    }

    fn finish(&mut self, id: &str) {
        if let Some(done) = self.done.get_mut(id) {
            *done = true;
        }
    }
}

fn ack(id: &str, state: AckState, error: Option<String>) -> Ack {
    Ack {
        id: id.to_owned(),
        state,
        error,
    }
}

async fn offered_names(offered: &Offered) -> Vec<String> {
    let offered = offered.clone();
    let mut names: Vec<String> = tokio::task::spawn_blocking(move || offered())
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|b| b.name)
        .collect();
    names.sort_unstable();
    names
}

/// Serve `machine`'s deliveries from `transport` until cancelled; `port` builds the run links,
/// `root` holds the workspaces of bots without a folder.
pub(crate) async fn serve<T: Transport>(
    transport: Arc<T>,
    machine: String,
    offered: Offered,
    (port, root): (u16, PathBuf),
    retry: Duration,
) {
    let (finished, mut done) = mpsc::unbounded_channel::<String>();
    let mut seen = Seen::default();
    let mut starts = JoinSet::new();
    let mut hello: Option<Hello> = None;
    let mut failing = false;
    loop {
        while let Ok(id) = done.try_recv() {
            seen.finish(&id);
        }
        while starts.try_join_next().is_some() {}
        let bots = offered_names(&offered).await;
        let current = match hello.take() {
            Some(h) if h.bots == bots => h,
            _ => {
                let next = Hello {
                    version: VERSION,
                    machine: machine.clone(),
                    bots,
                    rev: uuid::Uuid::new_v4().simple().to_string(),
                };
                if let Err(error) = transport.hello(&next).await {
                    if !std::mem::replace(&mut failing, true) {
                        eprintln!("connector hello failed: {error}");
                    }
                    sleep(retry).await;
                    continue;
                }
                next
            }
        };
        let deliveries = match transport.poll(&current.rev).await {
            Ok(deliveries) => deliveries,
            Err(Failure::HelloRequired) => continue,
            Err(error) => {
                if !std::mem::replace(&mut failing, true) {
                    eprintln!("connector poll failed: {error}");
                }
                hello = Some(current);
                sleep(retry).await;
                continue;
            }
        };
        failing = false;
        hello = Some(current);
        for delivery in deliveries {
            if let Some(was_done) = seen.see(&delivery.id) {
                let mut acks = vec![ack(&delivery.id, AckState::Received, None)];
                if was_done {
                    acks.push(ack(&delivery.id, AckState::Done, None));
                }
                let _ = transport.acks(&acks).await;
                continue;
            }
            // a lost ack is fine: the redelivery is acked from `seen`
            let _ = transport
                .acks(&[ack(&delivery.id, AckState::Received, None)])
                .await;
            match delivery.kind {
                Kind::Start {
                    bot,
                    text,
                    from,
                    agent,
                } => {
                    let job = Start {
                        transport: transport.clone(),
                        delivery: delivery.id,
                        offered: offered.clone(),
                        port,
                        root: root.clone(),
                        retry,
                    };
                    let finished = finished.clone();
                    starts.spawn(async move {
                        let id = job.delivery.clone();
                        let agent = agent.as_deref().and_then(Provider::parse);
                        job.run(&bot, &text, &from, agent).await;
                        let _ = finished.send(id);
                    });
                }
                Kind::Stop { run, epoch, turn } => {
                    let error = match super::get(&run) {
                        Some(run) => run.interrupt_turn(&epoch, turn).err(),
                        None => Some("no such run"),
                    };
                    seen.finish(&delivery.id);
                    let done = ack(&delivery.id, AckState::Done, error.map(str::to_owned));
                    let _ = transport.acks(&[done]).await;
                }
            }
        }
    }
}

struct Start<T> {
    transport: Arc<T>,
    delivery: String,
    offered: Offered,
    port: u16,
    root: PathBuf,
    retry: Duration,
}

impl<T: Transport> Start<T> {
    async fn run(&self, bot: &str, text: &str, from: &str, agent: Option<Provider>) {
        let offered = self.offered.clone();
        let found = tokio::task::spawn_blocking(move || offered())
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|b| b.name == bot);
        let started = found
            .ok_or("this machine no longer offers that bot")
            .and_then(|bot| {
                let overrides = super::bots::Overrides {
                    provider: agent,
                    ..Default::default()
                };
                super::bots::start(&bot, &self.root, from, text, "slack", overrides)
            });
        let run = started.and_then(|run| {
            let epoch = run.snapshot()["epoch"].as_str().map(str::to_owned);
            Ok((run, epoch.ok_or("the run has no epoch")?))
        });
        match run {
            Err(error) => {
                eprintln!("Slack run for {bot} not started: {error}");
                let (_, updates) = watch::channel(Status::Failed);
                self.report(None, None, updates).await;
            }
            Ok((run, epoch)) => {
                let (sender, updates) = watch::channel(Status::Starting);
                tokio::join!(
                    observe(&run, epoch.clone(), sender),
                    self.report(Some(&run), Some(&epoch), updates)
                );
            }
        }
        for _ in 0..EVENT_ATTEMPTS {
            let done = ack(&self.delivery, AckState::Done, None);
            if self.transport.acks(&[done]).await.is_ok() {
                break;
            }
            sleep(self.retry).await;
        }
    }

    /// Send each status change until a final one; events are idempotent, so a retry is harmless.
    async fn report(
        &self,
        run: Option<&Run>,
        epoch: Option<&str>,
        mut updates: watch::Receiver<Status>,
    ) {
        loop {
            let status = *updates.borrow_and_update();
            let event = Event {
                delivery: self.delivery.clone(),
                status,
                run: run.map(|r| r.id.clone()),
                epoch: epoch.map(str::to_owned),
                link: run.map(|r| format!("http://127.0.0.1:{}/open-agent/{}", self.port, r.id)),
            };
            for _ in 0..EVENT_ATTEMPTS {
                if self
                    .transport
                    .events(std::slice::from_ref(&event))
                    .await
                    .is_ok()
                {
                    break;
                }
                sleep(self.retry).await;
            }
            if status.terminal() || updates.changed().await.is_err() {
                return;
            }
        }
    }
}

impl Status {
    fn outcome(outcome: &Value) -> Self {
        match outcome.as_str() {
            Some("success") => Self::Completed,
            Some("interrupted") => Self::Stopped,
            _ => Self::Failed,
        }
    }
}

/// The first turn of a run, as its card shows it.
struct Turn {
    epoch: String,
    index: u64,
    waiting: usize,
    status: Status,
}

impl Turn {
    fn apply(&mut self, frame: &Value) {
        if frame["epoch"] != self.epoch || self.status.terminal() {
            return;
        }
        if frame["type"] == "snapshot" {
            let state = &frame["state"];
            self.index = state["turn"].as_u64().unwrap_or_default();
            self.waiting = state["interactions"].as_array().map_or(0, Vec::len);
            self.status = match (self.index, state["status"].as_str()) {
                (2.., _) => Status::Stopped,
                (_, Some("failed")) => Status::Failed,
                (_, Some("stopped")) => Status::Stopped,
                (1, Some("ready")) => Status::outcome(&state["outcome"]),
                (1, Some("interrupting")) => Status::Stopping,
                (1, Some("busy")) if self.waiting > 0 => Status::NeedsUser,
                (1, Some("busy")) => Status::Working,
                _ => Status::Starting,
            };
        } else {
            match frame["kind"].as_str() {
                Some("turn.started") => {
                    self.index += 1;
                    self.status = if self.index == 1 {
                        Status::Working
                    } else {
                        Status::Stopped
                    };
                }
                Some("turn.finished") if self.index == 1 => {
                    self.status = Status::outcome(&frame["payload"]["outcome"]);
                }
                Some("interaction.requested")
                    if self.status == Status::Working || self.status == Status::NeedsUser =>
                {
                    self.waiting += 1;
                    self.status = Status::NeedsUser;
                }
                Some("interaction.resolved" | "interaction.cancelled")
                    if self.status == Status::NeedsUser =>
                {
                    self.waiting = self.waiting.saturating_sub(1);
                    if self.waiting == 0 {
                        self.status = Status::Working;
                    }
                }
                Some("run.state") => match frame["payload"]["status"].as_str() {
                    Some("failed") => self.status = Status::Failed,
                    Some("stopped") => self.status = Status::Stopped,
                    Some("interrupting") if self.index == 1 => self.status = Status::Stopping,
                    _ => {}
                },
                _ => {}
            }
        }
    }
}

async fn observe(run: &Run, epoch: String, updates: watch::Sender<Status>) {
    let attached = run.attach(Some(&epoch), Some(0), false);
    let mut events = attached.rx;
    let mut turn = Turn {
        epoch,
        index: 0,
        waiting: 0,
        status: Status::Starting,
    };
    for event in attached.first {
        turn.apply(&event);
    }
    loop {
        updates.send_if_modified(|status| {
            let changed = *status != turn.status;
            *status = turn.status;
            changed
        });
        if turn.status.terminal() {
            return;
        }
        let Some(event) = run.next_event(&mut events).await else {
            break;
        };
        if event["epoch"]
            .as_str()
            .is_some_and(|epoch| epoch != turn.epoch)
        {
            break;
        }
        turn.apply(&event);
    }
    updates.send_replace(Status::Stopped);
}

/// How `run`'s first turn ended, once it has: `success`, `error` or `interrupted`.
pub(super) async fn first_turn(run: &Run) -> &'static str {
    let Some(epoch) = run.snapshot()["epoch"].as_str().map(str::to_owned) else {
        return "error";
    };
    let (sender, updates) = watch::channel(Status::Starting);
    observe(run, epoch, sender).await;
    match *updates.borrow() {
        Status::Completed => "success",
        Status::Failed => "error",
        _ => "interrupted",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn turn() -> Turn {
        Turn {
            epoch: "first".into(),
            index: 0,
            waiting: 0,
            status: Status::Starting,
        }
    }

    #[test]
    fn status_stays_on_the_first_turn() {
        let mut turn = turn();
        let event =
            |kind, payload| json!({"type":"event","epoch":"first","kind":kind,"payload":payload});
        for (frame, status) in [
            (event("turn.started", json!({})), Status::Working),
            (event("interaction.requested", json!({})), Status::NeedsUser),
            (event("interaction.requested", json!({})), Status::NeedsUser),
            (event("interaction.resolved", json!({})), Status::NeedsUser),
            (event("interaction.cancelled", json!({})), Status::Working),
            (
                event("turn.finished", json!({"outcome":"success"})),
                Status::Completed,
            ),
            (event("turn.started", json!({})), Status::Completed),
        ] {
            turn.apply(&frame);
            assert_eq!(turn.status, status);
        }
    }

    #[test]
    fn snapshot_recovers_the_first_turn_outcome() {
        for (outcome, status) in [
            ("success", Status::Completed),
            ("error", Status::Failed),
            ("interrupted", Status::Stopped),
        ] {
            let mut turn = turn();
            turn.apply(&json!({
                "type":"snapshot","epoch":"first",
                "state":{"turn":1,"status":"ready","outcome":outcome},
            }));
            assert_eq!(turn.status, status);
        }
    }

    #[test]
    fn a_seen_delivery_is_remembered_until_pushed_out() {
        let mut seen = Seen::default();
        assert_eq!(seen.see("a"), None);
        assert_eq!(seen.see("a"), Some(false));
        seen.finish("a");
        assert_eq!(seen.see("a"), Some(true));
        for i in 0..SEEN {
            seen.see(&i.to_string());
        }
        assert_eq!(seen.see("a"), None);
    }
}

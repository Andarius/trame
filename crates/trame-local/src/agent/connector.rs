//! The connector: the Slack side of the bridge. It keeps its runners' inventories, routes a mention
//! to the machine offering the bot, queues deliveries for that machine and edits the Slack card.

pub(crate) mod http;
pub(crate) mod protocol;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::json;
use tokio::{
    sync::{Notify, mpsc, oneshot, watch},
    task::JoinSet,
    time::{Instant, sleep_until},
};

use self::protocol::{Ack, AckState, Delivery, Event, Hello, Kind, Status, VERSION};
use super::run::Provider;
use super::runner::{self, Local, Offered};
use super::slack::{Access, Config, Input, Ledger, Mention, api::Api, own, status_card, timestamp};

const MAX_TRACKED_RUNS: usize = 8;
const MAX_BOTS: usize = 64;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Timing {
    /// an unacked delivery goes out again, same id, after this
    pub lease: Duration,
    /// a machine that has not polled for this long is shown as offline
    pub offline: Duration,
    /// a poll with nothing to deliver is held this long
    pub hold: Duration,
    pub start_ttl: Duration,
    pub stop_ttl: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            lease: Duration::from_secs(30),
            offline: Duration::from_secs(60),
            hold: Duration::from_secs(25),
            start_ttl: Duration::from_hours(24),
            stop_ttl: Duration::from_mins(5),
        }
    }
}

/// What the card of one start delivery shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Progress {
    pub machine: String,
    /// the machine has not picked the start up and is not polling
    pub waiting: bool,
    pub status: Status,
    pub run: Option<String>,
    pub epoch: Option<String>,
    pub link: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// the machine is unknown or polled under an old revision: hello again
    HelloRequired,
    Version,
    /// a hello for another machine than the caller's
    Machine,
}

struct Pending {
    delivery: Delivery,
    expires: Instant,
    leased: Option<Instant>,
    received: bool,
    /// told the done ack's refusal, if any
    done: Option<oneshot::Sender<Option<String>>>,
}

#[derive(Default)]
struct Machine {
    rev: Option<String>,
    bots: Vec<String>,
    seen: Option<Instant>,
    polling: usize,
    queue: Vec<Pending>,
    notify: Arc<Notify>,
}

impl Machine {
    fn online(&self, now: Instant, timing: &Timing) -> bool {
        self.polling > 0 || self.seen.is_some_and(|t| now <= t + timing.offline)
    }
}

struct Tracked {
    machine: String,
    progress: watch::Sender<Progress>,
}

#[derive(Default)]
struct State {
    machines: HashMap<String, Machine>,
    starts: HashMap<String, Tracked>,
}

impl State {
    /// Drop expired deliveries; a start not done by then fails its card.
    fn prune(&mut self, now: Instant) {
        let starts = &mut self.starts;
        for machine in self.machines.values_mut() {
            machine.queue.retain_mut(|p| {
                if p.expires > now {
                    return true;
                }
                if let Some(done) = p.done.take() {
                    let _ = done.send(Some("expired".into()));
                }
                if let Some(tracked) = starts.remove(&p.delivery.id) {
                    tracked.progress.send_modify(|progress| {
                        progress.waiting = false;
                        progress.status = Status::Failed;
                    });
                }
                false
            });
        }
    }
}

/// Machines, their queues and the starts' progress; in memory for now, so a restart forgets them.
pub(crate) struct Connector {
    state: Mutex<State>,
    timing: Timing,
}

impl Connector {
    pub(crate) fn new(timing: Timing) -> Self {
        Self {
            state: Mutex::default(),
            timing,
        }
    }

    /// Record `machine`'s inventory, as authenticated by the transport.
    pub(crate) fn hello(&self, machine: &str, hello: Hello) -> Result<(), Refusal> {
        if hello.version != VERSION {
            return Err(Refusal::Version);
        }
        if hello.machine != machine || machine.is_empty() || machine.len() > 64 {
            return Err(Refusal::Machine);
        }
        let mut bots: Vec<String> = hello
            .bots
            .into_iter()
            .filter(|b| super::bots::valid_name(b))
            .take(MAX_BOTS)
            .collect();
        bots.sort_unstable();
        bots.dedup();
        let mut state = self.state.lock().unwrap();
        let entry = state.machines.entry(machine.to_owned()).or_default();
        entry.rev = Some(hello.rev);
        entry.bots = bots;
        entry.notify.notify_one();
        Ok(())
    }

    /// The deliveries due to `machine`, held up to `hold` while there are none.
    pub(crate) async fn poll(&self, machine: &str, rev: &str) -> Result<Vec<Delivery>, Refusal> {
        let deadline = Instant::now() + self.timing.hold;
        let notify = {
            let mut state = self.state.lock().unwrap();
            let entry = state
                .machines
                .get_mut(machine)
                .filter(|m| m.rev.as_deref() == Some(rev))
                .ok_or(Refusal::HelloRequired)?;
            entry.polling += 1;
            entry.notify.clone()
        };
        let _polling = Polling {
            connector: self,
            machine,
        };
        loop {
            let now = Instant::now();
            let (ready, wake) = {
                let mut state = self.state.lock().unwrap();
                state.prune(now);
                let entry = state
                    .machines
                    .get_mut(machine)
                    .filter(|m| m.rev.as_deref() == Some(rev))
                    .ok_or(Refusal::HelloRequired)?;
                entry.seen = Some(now);
                let mut ready = Vec::new();
                let mut wake = deadline;
                for pending in entry.queue.iter_mut().filter(|p| !p.received) {
                    match pending.leased {
                        Some(until) if until > now => wake = wake.min(until),
                        _ => {
                            pending.leased = Some(now + self.timing.lease);
                            ready.push(pending.delivery.clone());
                        }
                    }
                }
                (ready, wake)
            };
            if !ready.is_empty() || now >= deadline {
                return Ok(ready);
            }
            tokio::select! {
                () = notify.notified() => {}
                () = sleep_until(wake) => {}
            }
        }
    }

    pub(crate) fn acks(&self, machine: &str, acks: Vec<Ack>) {
        let mut state = self.state.lock().unwrap();
        let State { machines, starts } = &mut *state;
        let Some(entry) = machines.get_mut(machine) else {
            return;
        };
        for ack in acks {
            let Some(at) = entry.queue.iter().position(|p| p.delivery.id == ack.id) else {
                continue;
            };
            if let Some(tracked) = starts.get(&ack.id) {
                tracked
                    .progress
                    .send_if_modified(|p| std::mem::replace(&mut p.waiting, false));
            }
            match ack.state {
                AckState::Received => entry.queue[at].received = true,
                AckState::Done => {
                    let mut pending = entry.queue.swap_remove(at);
                    if let Some(done) = pending.done.take() {
                        let _ = done.send(ack.error);
                    }
                }
            }
        }
    }

    /// Apply `machine`'s run statuses to its starts' cards; a finished card ignores later ones.
    pub(crate) fn events(&self, machine: &str, events: Vec<Event>) {
        let mut state = self.state.lock().unwrap();
        for event in events {
            let Some(tracked) = state
                .starts
                .get(&event.delivery)
                .filter(|t| t.machine == machine)
            else {
                continue;
            };
            tracked.progress.send_if_modified(|p| {
                let next = Progress {
                    machine: p.machine.clone(),
                    waiting: false,
                    status: event.status,
                    run: event.run.clone().or_else(|| p.run.clone()),
                    epoch: event.epoch.clone().or_else(|| p.epoch.clone()),
                    link: event.link.clone().or_else(|| p.link.clone()),
                };
                let changed = !p.status.terminal() && *p != next;
                if changed {
                    *p = next;
                }
                changed
            });
            if event.status.terminal() {
                state.starts.remove(&event.delivery);
            }
        }
    }

    /// Every `(machine, bot)` the runners offer.
    pub(crate) fn inventory(&self) -> Vec<(String, String)> {
        let state = self.state.lock().unwrap();
        let mut all: Vec<_> = state
            .machines
            .iter()
            .flat_map(|(m, e)| e.bots.iter().map(|b| (m.clone(), b.clone())))
            .collect();
        all.sort_unstable();
        all
    }

    /// `(machine, bot, task, agent)` for a mention: a bot name unique across machines picks its machine.
    pub(crate) fn route(
        &self,
        text: &str,
    ) -> Result<(String, String, String, Option<Provider>), String> {
        let inventory = self.inventory();
        let mut names: Vec<String> = inventory.iter().map(|(_, b)| b.clone()).collect();
        names.dedup();
        let (bot, task, agent) = super::bots::route(&names, text)?;
        let machines: Vec<&str> = inventory
            .iter()
            .filter(|(_, b)| *b == bot)
            .map(|(m, _)| m.as_str())
            .collect();
        match machines.as_slice() {
            [machine] => Ok(((*machine).to_owned(), bot, task, agent)),
            _ => Err(format!(
                "{bot} is offered by several machines ({}); rename one of them.",
                machines.join(", ")
            )),
        }
    }

    /// Queue a start for `machine`; the receiver follows its card.
    pub(crate) fn start(
        &self,
        machine: &str,
        bot: String,
        text: String,
        from: String,
        agent: Option<Provider>,
    ) -> (String, watch::Receiver<Progress>) {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        state.prune(now);
        let entry = state.machines.entry(machine.to_owned()).or_default();
        let (id, _) = queue(
            entry,
            Kind::Start {
                bot,
                text,
                from,
                agent: agent.map(|a| a.name().to_owned()),
            },
            now + self.timing.start_ttl,
            false,
        );
        let (progress, rx) = watch::channel(Progress {
            machine: machine.to_owned(),
            waiting: !entry.online(now, &self.timing),
            status: Status::Starting,
            run: None,
            epoch: None,
            link: None,
        });
        state.starts.insert(
            id.clone(),
            Tracked {
                machine: machine.to_owned(),
                progress,
            },
        );
        (id, rx)
    }

    /// Stop the first turn of start `delivery`'s run, refused once that turn is over.
    pub(crate) fn stop(
        &self,
        delivery: &str,
    ) -> Result<oneshot::Receiver<Option<String>>, &'static str> {
        let (machine, run, epoch) = {
            let state = self.state.lock().unwrap();
            let tracked = state.starts.get(delivery).ok_or("this run is over")?;
            let progress = tracked.progress.borrow();
            let (Some(run), Some(epoch)) = (&progress.run, &progress.epoch) else {
                return Err("this run has not started");
            };
            if !matches!(progress.status, Status::Working | Status::NeedsUser) {
                return Err("this turn is over");
            }
            (tracked.machine.clone(), run.clone(), epoch.clone())
        };
        Ok(self.stop_turn(&machine, run, epoch, 1))
    }

    /// Queue a stop of turn `turn` of `run` on `machine`; the receiver gets the runner's refusal, if any.
    pub(crate) fn stop_turn(
        &self,
        machine: &str,
        run: String,
        epoch: String,
        turn: u64,
    ) -> oneshot::Receiver<Option<String>> {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap();
        let entry = state.machines.entry(machine.to_owned()).or_default();
        let (_, done) = queue(
            entry,
            Kind::Stop { run, epoch, turn },
            now + self.timing.stop_ttl,
            true,
        );
        done.unwrap_or_else(|| oneshot::channel().1)
    }
}

fn queue(
    machine: &mut Machine,
    kind: Kind,
    expires: Instant,
    report: bool,
) -> (String, Option<oneshot::Receiver<Option<String>>>) {
    let id = uuid::Uuid::new_v4().to_string();
    let (done, rx) = if report {
        let (tx, rx) = oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    machine.queue.push(Pending {
        delivery: Delivery {
            id: id.clone(),
            kind,
        },
        expires,
        leased: None,
        received: false,
        done,
    });
    machine.notify.notify_one();
    (id, rx)
}

/// A poll in progress: the machine counts as online until it returns.
struct Polling<'a> {
    connector: &'a Connector,
    machine: &'a str,
}

impl Drop for Polling<'_> {
    fn drop(&mut self) {
        let mut state = self.connector.state.lock().unwrap();
        if let Some(entry) = state.machines.get_mut(self.machine) {
            entry.polling = entry.polling.saturating_sub(1);
            entry.seen = Some(Instant::now());
        }
    }
}

/// Holds the Slack apps here (the shared one and the bots' own) with this machine as their runner,
/// or runs for a remote connector when `TRAME_CONNECTOR_URL` is set.
pub(crate) async fn bridge(native: crate::routes::Native) {
    let machine = match crate::startup::node_id() {
        Ok(machine) => machine,
        Err(error) => return eprintln!("connector: {error}"),
    };
    let place = (native.port, native.root.clone());
    let ledger = Ledger::db(&native);
    let reader = native.clone();
    let offered: Offered = Arc::new(move || {
        crate::db::Db::connect(
            &reader.root.join("socket"),
            &reader.origin,
            Some(reader.settings.clone()),
        )
        .and_then(|mut db| super::bots::offered_to_slack(&mut db))
        .unwrap_or_default()
    });
    // a remote runner's bots answer through the connector's shared app; their own apps are local only for now
    match http::Remote::from_env().await {
        Ok(Some(remote)) => {
            return runner::serve(Arc::new(remote), machine, offered, place, runner::RETRY).await;
        }
        Ok(None) => {}
        Err(error) => return eprintln!("connector: {error}"),
    }
    let connector = Arc::new(Connector::new(Timing::default()));
    let apps = Arc::new(own::Apps::new(
        connector.clone(),
        machine.clone(),
        ledger.clone(),
        own::Apps::db_loader(native),
    ));
    let _ = own::APPS.set(apps.clone());
    apps.reconcile().await;
    let shared = async {
        let config = match Config::load().await {
            Ok(Some(config)) => Arc::new(config),
            Ok(None) => return std::future::pending().await,
            Err(error) => {
                eprintln!("Slack configuration: {error}");
                return std::future::pending().await;
            }
        };
        if let Access::Channel { channel, .. } = &config.access {
            let _ = SHARED.set(channel.clone());
        }
        let Ok(api) = Api::new(config.clone()).map(Arc::new) else {
            eprintln!("Slack HTTP client could not be started");
            return std::future::pending().await;
        };
        hold_slack(api, connector.clone(), ledger, None).await;
    };
    let local = Arc::new(Local::new(connector.clone(), machine.clone()));
    tokio::select! {
        () = shared => {}
        () = runner::serve(local, machine, offered, place, runner::RETRY) => {}
    }
}

/// The channel of the shared @Trame app this machine holds, once it is configured.
static SHARED: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub(crate) fn shared_channel() -> Option<&'static str> {
    SHARED.get().map(String::as_str)
}

/// The bot a bot's own Slack app starts, and the machine it runs on.
#[derive(Clone)]
pub(super) struct Own {
    pub machine: String,
    pub bot: String,
}

/// The Stop buttons on live cards: button → (channel, card message, start delivery).
type Buttons = Mutex<HashMap<String, (String, String, String)>>;

/// Listen to Slack and turn mentions and Stop clicks into deliveries until Slack refuses a token,
/// which it returns. `own` is the bot of a bot's own app; the shared app routes by bot name.
pub(super) async fn hold_slack(
    api: Arc<Api>,
    connector: Arc<Connector>,
    ledger: Ledger,
    own: Option<Own>,
) -> &'static str {
    let (input, mut recv) = mpsc::channel(64);
    let buttons = Arc::new(Buttons::default());
    let dispatch = async {
        let mut cards = JoinSet::new();
        loop {
            tokio::select! {
                event = recv.recv() => match event {
                    None => return,
                    Some(Input::Stop(stop)) => {
                        let delivery = buttons.lock().unwrap().get(&stop.button)
                            .filter(|(channel, message, _)| *channel == stop.channel && *message == stop.message)
                            .map(|(_, _, delivery)| delivery.clone());
                        let Some(delivery) = delivery else { continue };
                        match connector.stop(&delivery) {
                            Ok(done) => drop(tokio::spawn(async move {
                                if let Ok(Some(error)) = done.await {
                                    eprintln!("Slack Stop refused: {error}");
                                }
                            })),
                            Err(error) => eprintln!("Slack Stop refused: {error}"),
                        }
                    }
                    Some(Input::Mention(mention)) => match ledger.claim(&mention).await {
                        Ok(true) if cards.len() < MAX_TRACKED_RUNS => {
                            cards.spawn(card(api.clone(), connector.clone(), buttons.clone(), mention, own.clone()));
                        }
                        Ok(true) => eprintln!("Slack run limit reached"),
                        Ok(false) => {}
                        Err(_) => eprintln!("Slack event claim could not be saved"),
                    }
                },
                _ = cards.join_next(), if !cards.is_empty() => {}
            }
        }
    };
    tokio::select! {
        refused = api.listen(&input) => refused,
        () = dispatch => "the Slack listener stopped",
    }
}

/// Route a mention, queue its start and keep its thread card current.
async fn card(
    api: Arc<Api>,
    connector: Arc<Connector>,
    buttons: Arc<Buttons>,
    mention: Mention,
    own: Option<Own>,
) {
    let routed = match own {
        Some(own) => {
            let (task, agent) = super::bots::own_task(&own.bot, &mention.text);
            Ok((own.machine, own.bot, task, agent))
        }
        None => connector.route(&mention.text),
    };
    let (machine, bot, task, agent) = match routed {
        Ok(routed) => routed,
        Err(reason) => {
            let reply = json!({"channel":mention.channel,"thread_ts":mention.thread,"text":reason,
                "unfurl_links":false,"unfurl_media":false});
            let _ = api.message(&reply, false).await;
            return;
        }
    };
    let from = format!("Slack user {}", mention.user);
    let (delivery, mut progress) = connector.start(&machine, bot.clone(), task, from, agent);
    let button = uuid::Uuid::new_v4().simple().to_string();
    let initial = progress.borrow_and_update().clone();
    let first = status_card(&mention, &bot, &initial, &button, None);
    let Some(reply) = api.message(&first, false).await else {
        return;
    };
    let Some(message) = reply["ts"].as_str().filter(|ts| timestamp(ts)) else {
        return;
    };
    if reply["channel"] != mention.channel || initial.status.terminal() {
        return;
    }
    buttons.lock().unwrap().insert(
        button.clone(),
        (mention.channel.clone(), message.to_owned(), delivery),
    );
    while progress.changed().await.is_ok() {
        let next = progress.borrow_and_update().clone();
        let update = status_card(&mention, &bot, &next, &button, Some(message));
        if api.message(&update, true).await.is_none() || next.status.terminal() {
            break;
        }
    }
    buttons.lock().unwrap().remove(&button);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(machine: &str, bots: &[&str], rev: &str) -> Hello {
        Hello {
            version: VERSION,
            machine: machine.into(),
            bots: bots.iter().map(|b| (*b).to_owned()).collect(),
            rev: rev.into(),
        }
    }

    fn connector() -> Connector {
        Connector::new(Timing {
            lease: Duration::from_millis(50),
            offline: Duration::from_millis(50),
            hold: Duration::from_millis(200),
            start_ttl: Duration::from_millis(300),
            stop_ttl: Duration::from_millis(300),
        })
    }

    #[test]
    fn a_bot_name_picks_its_machine_unless_two_offer_it() {
        let connector = connector();
        connector
            .hello("m1", hello("m1", &["alpha", "both"], "1"))
            .unwrap();
        connector
            .hello("m2", hello("m2", &["beta", "both", "Not A Name"], "1"))
            .unwrap();
        for (text, want) in [
            ("alpha: x", Ok(("m1", "alpha", "x", None))),
            ("beta: y", Ok(("m2", "beta", "y", None))),
            (
                "beta with codex: y",
                Ok(("m2", "beta", "y", Some(Provider::Codex))),
            ),
            ("both: z", Err("several machines (m1, m2)")),
            ("gamma: z", Err("alpha, beta, both")),
        ] {
            let got = connector.route(text);
            match want {
                Ok((m, b, t, a)) => {
                    assert_eq!(got, Ok((m.into(), b.into(), t.into(), a)), "{text}");
                }
                Err(part) => assert!(got.unwrap_err().contains(part), "{text}"),
            }
        }
        assert_eq!(
            connector.hello("m1", hello("m2", &[], "1")),
            Err(Refusal::Machine)
        );
        let mut old = hello("m1", &[], "1");
        old.version = 0;
        assert_eq!(connector.hello("m1", old), Err(Refusal::Version));
    }

    #[tokio::test]
    async fn a_poll_under_a_stale_revision_needs_a_hello() {
        let connector = connector();
        assert_eq!(connector.poll("m1", "1").await, Err(Refusal::HelloRequired));
        connector.hello("m1", hello("m1", &["alpha"], "1")).unwrap();
        assert_eq!(connector.poll("m1", "1").await, Ok(Vec::new()));
        connector.hello("m1", hello("m1", &["alpha"], "2")).unwrap();
        assert_eq!(connector.poll("m1", "1").await, Err(Refusal::HelloRequired));
    }

    #[tokio::test]
    async fn an_unacked_delivery_comes_back_with_its_id_until_received() {
        let connector = connector();
        connector.hello("m1", hello("m1", &["alpha"], "1")).unwrap();
        let (id, progress) = connector.start("m1", "alpha".into(), "x".into(), "u".into(), None);
        assert!(progress.borrow().waiting, "m1 never polled");
        let first = connector.poll("m1", "1").await.unwrap();
        assert_eq!(first.iter().map(|d| &d.id).collect::<Vec<_>>(), [&id]);
        let again = connector.poll("m1", "1").await.unwrap();
        assert_eq!(again, first, "redelivered after the lease");
        connector.acks(
            "m1",
            vec![Ack {
                id: id.clone(),
                state: AckState::Received,
                error: None,
            }],
        );
        assert!(!progress.borrow().waiting);
        assert_eq!(connector.poll("m1", "1").await, Ok(Vec::new()));
    }

    #[tokio::test]
    async fn a_start_nobody_picks_up_fails_and_a_finished_one_refuses_stop() {
        let connector = connector();
        connector.hello("m1", hello("m1", &["alpha"], "1")).unwrap();
        let (_, lost) = connector.start("m1", "alpha".into(), "x".into(), "u".into(), None);
        tokio::time::sleep(Duration::from_millis(350)).await;
        let (id, progress) = connector.start("m1", "alpha".into(), "y".into(), "u".into(), None);
        assert_eq!(lost.borrow().status, Status::Failed);
        let event = |status| Event {
            delivery: id.clone(),
            status,
            run: Some("r".into()),
            epoch: Some("e".into()),
            link: None,
        };
        connector.events("m2", vec![event(Status::Working)]);
        assert_eq!(progress.borrow().status, Status::Starting, "not m2's run");
        connector.events("m1", vec![event(Status::Working)]);
        assert!(connector.stop(&id).is_ok());
        connector.events("m1", vec![event(Status::Completed), event(Status::Working)]);
        assert_eq!(progress.borrow().status, Status::Completed);
        assert_eq!(connector.stop(&id).unwrap_err(), "this run is over");
    }
}

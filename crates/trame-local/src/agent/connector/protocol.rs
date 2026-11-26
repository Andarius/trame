//! The connector ↔ runner delivery protocol, shared by the in-process and HTTP transports.

use serde::{Deserialize, Serialize};

pub(crate) const VERSION: u32 = 1;

/// A runner's inventory: its machine name and the bots it offers; `rev` names this hello.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Hello {
    pub version: u32,
    pub machine: String,
    pub bots: Vec<String>,
    pub rev: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Poll {
    pub rev: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Deliveries {
    pub deliveries: Vec<Delivery>,
}

/// Work for one machine; redelivered under the same `id` until acked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Delivery {
    pub id: String,
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Kind {
    Start {
        bot: String,
        text: String,
        from: String,
    },
    /// Interrupt turn `turn` of incarnation `epoch` of `run`, only while it is that turn.
    Stop {
        run: String,
        epoch: String,
        turn: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AckState {
    Received,
    Done,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Ack {
    pub id: String,
    pub state: AckState,
    /// why a done delivery was refused, as a stale stop
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Acks {
    pub acks: Vec<Ack>,
}

/// A start delivery's run status; the latest per delivery wins, so resending is harmless.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Event {
    pub delivery: String,
    pub status: Status,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub epoch: Option<String>,
    #[serde(default)]
    pub link: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Events {
    pub events: Vec<Event>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Status {
    Starting,
    Working,
    NeedsUser,
    Stopping,
    Completed,
    Failed,
    Stopped,
}

impl Status {
    pub(crate) fn summary(self, bot: &str) -> String {
        let state = match self {
            Self::Starting => "is starting",
            Self::Working => "is working",
            Self::NeedsUser => "needs your input",
            Self::Stopping => "is stopping",
            Self::Completed => "finished",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        };
        format!("{bot} {state}")
    }

    pub(crate) fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Stopped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_shapes_stay_stable() {
        let start = Delivery {
            id: "d1".into(),
            kind: Kind::Start {
                bot: "trame".into(),
                text: "fix".into(),
                from: "Slack user U1".into(),
            },
        };
        let stop = Delivery {
            id: "d2".into(),
            kind: Kind::Stop {
                run: "r".into(),
                epoch: "e".into(),
                turn: 1,
            },
        };
        for (value, wire) in [
            (
                serde_json::to_value(&start).unwrap(),
                json!({"id":"d1","kind":"start","bot":"trame","text":"fix","from":"Slack user U1"}),
            ),
            (
                serde_json::to_value(&stop).unwrap(),
                json!({"id":"d2","kind":"stop","run":"r","epoch":"e","turn":1}),
            ),
            (
                serde_json::to_value(Ack {
                    id: "d1".into(),
                    state: AckState::Received,
                    error: None,
                })
                .unwrap(),
                json!({"id":"d1","state":"received"}),
            ),
            (
                serde_json::to_value(Status::NeedsUser).unwrap(),
                json!("needs_user"),
            ),
        ] {
            assert_eq!(value, wire);
        }
        let back: Delivery = serde_json::from_value(serde_json::to_value(&stop).unwrap()).unwrap();
        assert_eq!(back, stop);
    }
}

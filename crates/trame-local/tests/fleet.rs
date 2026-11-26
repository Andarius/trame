mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::{db::Db, pg, routes::hub_handle, udb::formula::Executor};

fn hub(t: &TestDb, node: &str) -> Db {
    let mut client = pg::connect(&t.root).unwrap();
    let formula = Executor::for_hub(&mut client, &postgres::Config::new(), None).unwrap();
    Db::for_hub(client, node.into(), formula)
}

#[test]
fn the_hub_hands_each_device_the_others_agents() {
    let t = TestDb::new();
    let push = |node: &str, agents: Value| {
        hub_handle(
            &mut hub(&t, node),
            "POST",
            "/api/fleet",
            "",
            &json!({"label":node,"agents":agents}),
        )
        .unwrap()
    };
    let (status, others) = push(
        "mac",
        json!([{"id":"s1","agent":"claude","name":"billing-docs","waiting":"input needed"}]),
    );
    assert_eq!((status, others), (200, json!([])));
    let (_, others) = push("linux", json!([]));
    assert_eq!(others.as_array().unwrap().len(), 1);
    assert_eq!(others[0]["label"], "mac");
    assert_eq!(others[0]["agents"][0]["waiting"], "input needed");
}

mod common;
use common::TestDb;
use serde_json::{Value, json};
use trame_local::share;

fn page(t: &mut TestDb, body: Value) -> Value {
    t.request("POST", "/api/pages", body).1["id"].clone()
}
fn database(t: &mut TestDb, name: &str, page: &Value) -> Value {
    let id = t.request("POST", "/api/udb", json!({"name":name})).1["id"].clone();
    t.request(
        "POST",
        &format!("/api/udb/{}", id.as_str().unwrap()),
        json!({"page_id":page}),
    );
    id
}
fn title_prop(t: &mut TestDb, id: &Value) -> Value {
    t.db.query(
        "select id from udb_properties where db_id=$1 and type='title'",
        &[id.clone()],
    )
    .unwrap()[0]["id"]
        .clone()
}

#[test]
fn subtree_roundtrip_preserves_every_typescript_assertion() {
    let mut t = TestDb::new();
    let root = page(&mut t, json!({"title":"Shared root","kind":"page"}));
    page(
        &mut t,
        json!({"title":"Child note","kind":"page","parent_id":root}),
    );
    let db = database(&mut t, "Shared DB", &root);
    let tp = title_prop(&mut t, &db);
    for title in ["row-a", "row-b"] {
        t.request(
            "POST",
            &format!("/api/udb/{}/rows", db.as_str().unwrap()),
            json!({"vals":{tp.as_str().unwrap():title}}),
        );
    }
    let bundle = share::export(&mut t.db, root.as_str().unwrap()).unwrap();
    assert!(!bundle.is_null());
    assert_eq!(bundle["root"], root);
    let mut titles = bundle["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap())
        .collect::<Vec<_>>();
    titles.sort();
    assert_eq!(titles, vec!["Child note", "Shared root"]);
    assert_eq!(
        bundle["databases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("Shared DB")]
    );
    assert_eq!(bundle["rows"].as_array().unwrap().len(), 2);
    let imported = share::import(&mut t.db, &bundle, &Value::Null).unwrap();
    assert_ne!(imported, root);
    let roots =
        t.db.query(
            "select id,origin from pages where title='Shared root' and not deleted",
            &[],
        )
        .unwrap();
    assert_eq!(roots.len(), 2);
    assert_eq!(
        roots.iter().find(|r| r["id"] == imported).unwrap()["origin"],
        t.db.origin
    );
    let children =
        t.db.query(
            "select parent_id from pages where title='Child note' and not deleted",
            &[],
        )
        .unwrap();
    assert_eq!(children.len(), 2);
    assert!(children.iter().any(|c| c["parent_id"] == imported));
    assert!(children.iter().any(|c| c["parent_id"] == root));
    let databases =
        t.db.query(
            "select id,page_id from udb_databases where name='Shared DB' and not deleted",
            &[],
        )
        .unwrap();
    assert_eq!(databases.len(), 2);
    let copied = databases.iter().find(|d| d["id"] != db).unwrap();
    assert_eq!(copied["page_id"], imported);
    assert_eq!(
        t.db.query(
            "select count(*)::int as n from udb_rows where db_id=$1 and not deleted",
            &[copied["id"].clone()]
        )
        .unwrap()[0]["n"],
        2
    );
}

#[test]
fn dangling_relation_typescript_assertions() {
    let mut t = TestDb::new();
    let outside = page(&mut t, json!({"title":"Outside","kind":"page"}));
    let db1 = database(&mut t, "Target DB", &outside);
    let root = page(&mut t, json!({"title":"Rel root","kind":"page"}));
    let db2 = database(&mut t, "Owner DB", &root);
    t.request(
        "POST",
        &format!("/api/udb/{}/props", db2.as_str().unwrap()),
        json!({"name":"Ref","type":"relation","config":{"target_db":db1}}),
    );
    let bundle = share::export(&mut t.db, root.as_str().unwrap()).unwrap();
    assert!(!bundle.is_null());
    assert_eq!(
        bundle["databases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].clone())
            .collect::<Vec<_>>(),
        vec![json!("Owner DB")]
    );
    assert!(
        bundle["properties"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["type"] == "relation")
    );
    let imported = share::import(&mut t.db, &bundle, &Value::Null).unwrap();
    let db=t.db.query("select d.id from udb_databases d join pages p on p.id=d.page_id where d.name='Owner DB' and p.id=$1 and not d.deleted",&[imported]).unwrap()[0]["id"].clone();
    assert_eq!(t.db.query("select count(*)::int as n from udb_properties where db_id=$1 and type='relation' and not deleted",&[db]).unwrap()[0]["n"],0);
}

#[test]
fn remapped_views_and_page_color_typescript_assertions() {
    let mut t = TestDb::new();
    let root = page(&mut t, json!({"title":"Views root","kind":"project"}));
    t.db.query(
        "update pages set color=$2 where id=$1",
        &[root.clone(), json!("#c98a63")],
    )
    .unwrap();
    let db = database(&mut t, "Viewy DB", &root);
    let tp = title_prop(&mut t, &db);
    let pts = t
        .request(
            "POST",
            &format!("/api/udb/{}/props", db.as_str().unwrap()),
            json!({"name":"Pts","type":"number"}),
        )
        .1["id"]
        .clone();
    t.db.query("update udb_databases set views=$2 where id=$1",&[db.clone(),json!({"tabs":[{"id":"t1","name":"By pts","config":{"sorts":[{"propId":pts,"dir":-1}],"filters":[{"propId":tp,"op":"contains","value":"a"}],"groupBy":tp,"aggs":{pts.as_str().unwrap():"sum"}}}],"active":"t1"})]).unwrap();
    let bundle = share::export(&mut t.db, root.as_str().unwrap()).unwrap();
    let imported = share::import(&mut t.db, &bundle, &Value::Null).unwrap();
    let database =
        t.db.query(
            "select id,views from udb_databases where page_id=$1 and not deleted",
            &[imported.clone()],
        )
        .unwrap()
        .remove(0);
    let props =
        t.db.query(
            "select id,name,type from udb_properties where db_id=$1 and not deleted",
            &[database["id"].clone()],
        )
        .unwrap();
    let new_pts = &props.iter().find(|p| p["name"] == "Pts").unwrap()["id"];
    let new_title = &props.iter().find(|p| p["type"] == "title").unwrap()["id"];
    assert_ne!(new_pts, &pts);
    let config = &database["views"]["tabs"][0]["config"];
    assert_eq!(&config["sorts"][0]["propId"], new_pts);
    assert_eq!(&config["filters"][0]["propId"], new_title);
    assert_eq!(&config["groupBy"], new_title);
    assert_eq!(
        config["aggs"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec![new_pts.as_str().unwrap()]
    );
    assert_eq!(
        t.db.query("select color from pages where id=$1", &[imported])
            .unwrap()[0]["color"],
        "#c98a63"
    );
}

#[test]
fn invalid_bundle_assertion_and_failed_import_rolls_back() {
    let mut t = TestDb::new();
    assert_eq!(
        share::import(&mut t.db, &json!({"nope":true}), &Value::Null)
            .unwrap_err()
            .to_string(),
        "not a Trame page bundle"
    );
    let id = page(&mut t, json!({"title":"Atomic import"}));
    let mut bundle = share::export(&mut t.db, id.as_str().unwrap()).unwrap();
    let before =
        t.db.query("select count(*)::int as n from pages", &[])
            .unwrap();
    bundle["databases"] = json!([{"id":"bad","name":null,"sort_key":"i","views":[],"page_id":id}]);
    assert!(share::import(&mut t.db, &bundle, &Value::Null).is_err());
    assert_eq!(
        t.db.query("select count(*)::int as n from pages", &[])
            .unwrap(),
        before
    );
}

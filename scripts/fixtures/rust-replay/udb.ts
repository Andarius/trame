// DESCRIPTION: Replay the complete UDB HTTP contract on deterministic TS/Rust database twins.
// USAGE: Import replayUdb into scripts/rust-pages-diff.ts and pass its request function.
// deno-lint-ignore no-explicit-any
type Request = (method: string, path: string, body?: unknown) => Promise<any>;

export async function replayUdb(request: Request): Promise<void> {
  const post = (path: string, body: unknown = {}) => request("POST", path, body);
  const dbPath = (id: string) => `/api/udb/${id}`;
  const left = (await post("/api/udb", { name: "UDB replay A" })).id as string;
  const right = (await post("/api/udb", { name: "UDB replay B" })).id as string;
  await request("GET", "/api/udb");
  await request("GET", dbPath(left));
  await request("GET", dbPath(right));
  await request("GET", "/api/udb/icons");
  await request("POST", "/api/udb/icons");
  await request("GET", dbPath("77777777-7777-4777-8777-999999999999"));
  const page = (await post("/api/pages", { title: "UDB replay parent" })).id as string;
  await post(dbPath(left), { name: "Renamed replay A", icon: "🧪", page_id: page,
    views: { active: "v", tabs: [{ id: "v", name: "Board", config: { sorts: [] } }] } });
  await post(dbPath(left), { icon: null, views: [] });
  await request("GET", dbPath(left));
  const aTitle = (await request("GET", dbPath(left))).properties[0].id as string;
  const bTitle = (await request("GET", dbPath(right))).properties[0].id as string;
  const score = (await post(dbPath(left) + "/props", { name: "Score", type: "number" })).id as string;
  const flag = (await post(dbPath(left) + "/props", { name: "Enabled", type: "checkbox" })).id as string;
  const when = (await post(dbPath(left) + "/props", { name: "When", type: "date" })).id as string;
  const select = (await post(dbPath(left) + "/props", { name: "Priority", type: "select",
    config: { options: [{ id: "hi", name: "High", color: "red" }] } })).id as string;
  await post(`/api/udb/props/${select}`, { name: "Rank", width: 191, sort_key: "z5",
    config: { options: [{ id: "hi", name: "High", color: "orange" }] } });
  await post(`/api/udb/props/${select}`, { width: null });
  const ar = (await post(dbPath(left) + "/rows", { vals: { [aTitle]: "source", [score]: 42,
    [flag]: false, [when]: { start: "2030-01-01" }, [select]: "hi" }, icon: "⭐" })).id as string;
  const br = (await post(dbPath(right) + "/rows", { vals: { [bTitle]: "target" },
    icon: "data:image/png;base64,example" })).id as string;
  await post(`/api/udb/rows/${ar}`, { vals: { [aTitle]: "source updated", [score]: 84,
    [flag]: false, [select]: null }, icon: null });
  await request("GET", dbPath(left));
  await request("GET", "/api/udb/icons");
  const relation = (await post(dbPath(left) + "/props", { name: "Reference", type: "relation",
    config: { target_db: right, reverse_name: "Back" } })).id as string;
  const reverse = (await request("GET", dbPath(right))).properties.find((p: { type: string }) =>
    p.type === "relation").id as string;
  await post("/api/udb/links", { prop_id: relation, from_row: ar, to_row: br });
  await post("/api/udb/links", { prop_id: relation, from_row: ar, to_row: br });
  await request("GET", dbPath(left));
  await request("GET", dbPath(right));
  const count = (await post(dbPath(left) + "/props", { name: "Count", type: "rollup",
    config: { relation_prop: relation, agg: "count" } })).id as string;
  const sum = (await post(dbPath(right) + "/props", { name: "Sum", type: "rollup",
    config: { relation_prop: reverse, target_prop: score, agg: "sum" } })).id as string;
  await request("GET", dbPath(left));
  await request("GET", dbPath(right));
  await post(dbPath(left) + "/props", { name: "Bad rollup", type: "rollup", config: {} });
  await post(dbPath(left) + "/props", { name: "Bad target", type: "rollup",
    config: { relation_prop: relation, agg: "sum" } });
  const formula = (await post(dbPath(left) + "/props", { name: "Double", type: "formula",
    config: { expr: "Score * 2" } })).id as string;
  await request("GET", dbPath(left));
  await post(`/api/udb/props/${formula}`, { config: { expr: "case when Enabled then 1 else Score + 1 end" } });
  await request("GET", dbPath(left));
  await post(dbPath(left) + "/props", { name: "Unknown", type: "formula",
    config: { expr: "bogus_prop + 1" } });
  await post(dbPath(left) + "/props", { name: "Malformed", type: "formula",
    config: { expr: "Score +" } });
  await post(`/api/udb/props/${formula}`, { config: { expr: "missing + 1" } });
  await post("/api/udb/links", { prop_id: reverse, from_row: br, to_row: ar, remove: true });
  await request("GET", dbPath(left));
  await post("/api/udb/links", { prop_id: reverse, from_row: br, to_row: ar });
  await request("GET", dbPath(right));
  await post(`/api/udb/props/${relation}/delete`);
  await request("GET", dbPath(left));
  await request("GET", dbPath(right));
  await post(`/api/udb/props/${count}/delete`);
  await post(`/api/udb/props/${sum}/delete`);
  await post(`/api/udb/props/${formula}/delete`);
  await post(`/api/udb/rows/${ar}/delete`);
  await request("GET", dbPath(left));
  await post(dbPath(left) + "/delete");
  await post(dbPath(right) + "/delete");
  await request("GET", "/api/udb");
  await request("GET", dbPath(left));
}

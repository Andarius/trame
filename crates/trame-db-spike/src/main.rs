use postgres::{Client, NoTls};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct Export {
    tables: Vec<Table>,
    sequences: Vec<Value>,
}

#[derive(Deserialize)]
struct Table {
    name: String,
    columns: Vec<Value>,
    rows: Vec<Vec<Option<String>>>,
    tombstones: Option<usize>,
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn owned_path(path: &Path, scratch: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let resolved = path.canonicalize()?;
    if !resolved.starts_with(scratch) || resolved == scratch {
        return Err("database paths must resolve inside this worktree's .scratch".into());
    }
    Ok(resolved)
}

fn require_data_directory(
    actual: &Path,
    expected: &Path,
    scratch: &Path,
) -> Result<(), Box<dyn Error>> {
    if owned_path(actual, scratch)? != owned_path(expected, scratch)? {
        return Err("refusing DDL: connected database is not the owned scratch cluster".into());
    }
    Ok(())
}

fn canonical(rows: &[Vec<Option<String>>]) -> Result<Vec<String>, serde_json::Error> {
    let mut encoded = rows
        .iter()
        .map(serde_json::to_string)
        .collect::<Result<Vec<_>, _>>()?;
    encoded.sort();
    Ok(encoded)
}

fn compare(client: &mut Client, export: &Export) -> Result<Value, Box<dyn Error>> {
    client
        .batch_execute("SET timezone='UTC'; SET datestyle='ISO, YMD'; SET extra_float_digits=3;")?;
    let mut tables = Vec::new();
    for table in &export.tables {
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|c| quote(c["name"].as_str().unwrap()))
            .collect();
        let sql = format!(
            "SELECT json_build_array({})::text FROM {}",
            columns
                .iter()
                .map(|c| format!("{c}::text"))
                .collect::<Vec<_>>()
                .join(","),
            quote(&table.name)
        );
        let actual: Vec<Vec<Option<String>>> = client
            .query(&sql, &[])?
            .into_iter()
            .map(|r| serde_json::from_str(r.get::<_, &str>(0)))
            .collect::<Result<_, _>>()?;
        let expected = canonical(&table.rows)?;
        let observed = canonical(&actual)?;
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&observed)?));
        let metadata: Value = serde_json::from_str(client.query_one(
            "SELECT coalesce(json_agg(c ORDER BY c.pos),'[]')::text FROM (SELECT a.attnum as pos, a.attname as name, format_type(a.atttypid,a.atttypmod) as type, not a.attnotnull as nullable, pg_get_expr(d.adbin,d.adrelid) as default, a.attidentity as identity, a.attgenerated as generated FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid and d.adnum=a.attnum WHERE c.relnamespace='public'::regnamespace and c.relname=$1 and a.attnum>0 and not a.attisdropped) c", &[&table.name])?.get::<_, &str>(0))?;
        let metadata: Vec<Value> = metadata
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|mut c| {
                c.as_object_mut().unwrap().remove("pos");
                c
            })
            .collect();
        let column_order_equal = metadata
            .iter()
            .map(|c| &c["name"])
            .eq(table.columns.iter().map(|c| &c["name"]));
        let mut observed_columns = metadata.clone();
        let mut expected_columns = table.columns.clone();
        observed_columns.sort_by_key(|c| c["name"].to_string());
        expected_columns.sort_by_key(|c| c["name"].to_string());
        let schema_equal = observed_columns == expected_columns;
        let differences: Vec<Value> = expected_columns
            .iter()
            .filter(|c| !observed_columns.contains(c))
            .cloned()
            .collect();
        let expected_hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&expected)?));
        tables.push(json!({"name":table.name,"rows":actual.len(),"tombstones":table.tombstones,"all_cells_equal":expected==observed,"schema_equal":schema_equal,"column_order_equal":column_order_equal,"expected_columns_changed":differences,"canonical_sha256":hash,"expected_sha256":expected_hash}));
    }
    let mut sequences = Vec::new();
    for sequence in &export.sequences {
        let name = sequence["name"].as_str().unwrap();
        let row = client.query_one(
            &format!("SELECT last_value::text,is_called FROM {}", quote(name)),
            &[],
        )?;
        let value: String = row.get(0);
        let called: bool = row.get(1);
        sequences.push(json!({"name":name,"state_equal":sequence["value"]==value && sequence["called"]==called}));
    }
    let pass = tables
        .iter()
        .all(|t| t["all_cells_equal"] == true && t["schema_equal"] == true)
        && sequences.iter().all(|s| s["state_equal"] == true);
    Ok(json!({"pass":pass,"tables":tables,"sequences":sequences}))
}

fn validate_foreign_keys(client: &mut Client) -> Result<Value, Box<dyn Error>> {
    let constraints = client.query("SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid WHERE con.contype='f' and c.relnamespace='public'::regnamespace ORDER BY c.relname, con.conname", &[])?;
    let mut checks = Vec::new();
    for constraint in constraints {
        let table: String = constraint.get(0);
        let name: String = constraint.get(1);
        let definition: String = constraint.get(2);
        client.batch_execute("BEGIN")?;
        let result = client.batch_execute(&format!("ALTER TABLE {} DROP CONSTRAINT {}; ALTER TABLE {} ADD CONSTRAINT {} {} NOT VALID; ALTER TABLE {} VALIDATE CONSTRAINT {};", quote(&table), quote(&name), quote(&table), quote(&name), definition, quote(&table), quote(&name)));
        client.batch_execute("ROLLBACK")?;
        checks.push(json!({"table":table,"constraint":name,"pass":result.is_ok()}));
    }
    Ok(json!({"pass":checks.iter().all(|c| c["pass"]==true),"checks":checks}))
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 5 {
        return Err(
            "usage: trame-db-spike <export.json> <schema.sql> <pglite.wasm> <socket-dir>".into(),
        );
    }
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.scratch")
        .canonicalize()?;
    let socket = owned_path(Path::new(&args[4]), &scratch)?;
    let export: Export = serde_json::from_slice(&fs::read(&args[1])?)?;
    let schema = fs::read_to_string(&args[2])?;
    let engine = wasmi::Engine::default();
    let module = wasmi::Module::new(&engine, &fs::read(&args[3])?[..]);
    let wasm = match module {
        Ok(module) => {
            let imports: Vec<Value> = module
                .imports()
                .map(|i| json!({"module":i.module(),"name":i.name()}))
                .collect();
            let linker = wasmi::Linker::<()>::new(&engine);
            let mut store = wasmi::Store::new(&engine, ());
            let result = linker.instantiate_and_start(&mut store, &module);
            json!({"compiled":true,"instantiated":result.is_ok(),"error":result.err().map(|e| e.to_string()),"imports":imports})
        }
        Err(e) => json!({"compiled":false,"instantiated":false,"error":e.to_string()}),
    };
    let sqlite = rusqlite::Connection::open_in_memory()?;
    let sqlite_result = sqlite.execute_batch(&schema);
    let mut config = postgres::Config::new();
    config
        .host_path(socket)
        .port(55438)
        .user(&env::var("USER")?)
        .dbname("postgres");
    let mut client = config.connect(NoTls)?;
    let data_directory: String = client.query_one("SHOW data_directory", &[])?.get(0);
    require_data_directory(
        Path::new(&data_directory),
        &scratch.join("stage0/pg18-data"),
        &scratch,
    )?;
    let before = compare(&mut client, &export)?;
    let foreign_keys = validate_foreign_keys(&mut client)?;
    client.batch_execute(&schema)?;
    let after = compare(&mut client, &export)?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"pglite_rust_wasm":wasm,"sqlite_unchanged_schema":{"pass":sqlite_result.is_ok(),"error":sqlite_result.err().map(|e| e.to_string())},"postgres_version":client.query_one("SHOW server_version", &[])?.get::<_,String>(0),"migration_before_schema_reapply":before,"migration_foreign_keys":foreign_keys,"migration_after_schema_reapply":after})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ddl_requires_owned_exact_cluster_and_rejects_symlink_escape() -> Result<(), Box<dyn Error>> {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.scratch")
            .canonicalize()?;
        let temp = scratch.join(format!("db-path-test-{}", std::process::id()));
        fs::create_dir(&temp)?;
        let check = || -> Result<(), Box<dyn Error>> {
            fs::create_dir(temp.join("cluster"))?;
            fs::create_dir(temp.join("other"))?;
            require_data_directory(&temp.join("cluster"), &temp.join("cluster"), &scratch)?;
            assert!(
                require_data_directory(&temp.join("other"), &temp.join("cluster"), &scratch)
                    .is_err()
            );
            assert!(owned_path(scratch.parent().unwrap(), &scratch).is_err());
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(scratch.parent().unwrap(), temp.join("escape"))?;
                assert!(owned_path(&temp.join("escape"), &scratch).is_err());
            }
            Ok(())
        };
        let result = check();
        fs::remove_dir_all(temp)?;
        result
    }
}

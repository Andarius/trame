use anyhow::{Result, bail};
use postgres::Client;
use trame_local::token;

pub(crate) fn ensure_schema(client: &mut Client) -> Result<()> {
    client.batch_execute(
        "CREATE TABLE IF NOT EXISTS api_tokens (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            token_hash text NOT NULL UNIQUE,
            node_id text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            revoked boolean NOT NULL DEFAULT false
         );
         COMMENT ON TABLE api_tokens IS
           'Hub-only: per-device opaque API tokens (sha-256 of the token). Revoke by flipping revoked.'",
    )?;
    Ok(())
}

pub(crate) fn mint(client: &mut Client, node: &str, explicit_user: Option<&str>) -> Result<String> {
    let mut tx = client.transaction()?;
    // Device bindings have no unique index on node_id.
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&node],
    )?;
    if tx
        .query_opt(
            "SELECT 1 FROM devices WHERE node_id=$1 AND NOT deleted LIMIT 1",
            &[&node],
        )?
        .is_none()
    {
        let user = if let Some(id) = explicit_user {
            id.to_owned()
        } else {
            let members = tx.query(
                "SELECT id::text FROM users WHERE role='member' AND NOT deleted LIMIT 2",
                &[],
            )?;
            let [member] = members.as_slice() else {
                bail!("pass a user ID when there is no single active member");
            };
            member.get(0)
        };
        tx.execute(
            "INSERT INTO devices (node_id, user_id, origin) VALUES ($1, $2::text::uuid, 'hub-api')",
            &[&node, &user],
        )?;
    }
    let token = token::generate()?;
    tx.execute(
        "INSERT INTO api_tokens (token_hash, node_id) VALUES ($1, $2)",
        &[&token::hash(&token), &node],
    )?;
    tx.commit()?;
    Ok(token)
}

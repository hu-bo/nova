use crate::proto::nova::runner::v1::{Operation, operation::Params};
use prost::Message;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn operation_digest(operation: &Operation) -> Result<[u8; 32], String> {
    let params = match operation
        .params
        .as_ref()
        .ok_or("operation params missing")?
    {
        Params::ListFiles(p) => json!(["listFiles", p.path, p.depth, p.max_entries]),
        Params::ReadFile(p) => json!(["readFile", p.path, p.offset.to_string(), p.max_bytes]),
        Params::ReadText(p) => json!([
            "readText",
            p.path,
            p.offset.to_string(),
            p.limit,
            p.max_bytes
        ]),
        Params::Search(p) => json!(["search", p.query, p.path, p.glob, p.max_results]),
        Params::WriteFile(p) => json!([
            "writeFile",
            p.path,
            bytes_value(&p.contents),
            p.expected_sha256
        ]),
        Params::ApplyPatch(p) => json!([
            "applyPatch",
            p.path,
            p.edits
                .iter()
                .map(|e| json!([e.old_text, e.new_text]))
                .collect::<Vec<_>>(),
            p.expected_sha256
        ]),
        Params::ExecuteCommand(p) => {
            let mut env: Vec<_> = p.env.iter().collect();
            env.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let entries: Vec<Value> = env
                .into_iter()
                .map(|(key, value)| json!([key, value]))
                .collect();
            json!([
                "executeCommand",
                p.executable,
                p.args,
                p.cwd,
                entries,
                p.timeout_ms,
                bytes_value(&p.stdin)
            ])
        }
    };
    let canonical = json!([
        operation.operation_id,
        operation.target_boot_id,
        operation.workspace_id,
        operation.protocol_version,
        operation.expires_at_unix_ms.to_string(),
        operation.timeout_ms,
        params,
    ]);
    let bytes = serde_json::to_vec(&canonical).map_err(|_| "operation canonicalization failed")?;
    Ok(Sha256::digest(bytes).into())
}

fn bytes_value(bytes: &[u8]) -> Value {
    Value::Array(bytes.iter().map(|byte| json!(*byte)).collect())
}

#[allow(dead_code)]
fn decode_operation(
    bytes: &[u8],
) -> Result<crate::proto::nova::runner::v1::Operation, prost::DecodeError> {
    Operation::decode(bytes)
}

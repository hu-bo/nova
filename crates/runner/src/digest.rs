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
        // 与 packages/runner-protocol/src/index.ts 的 canonicalParams 逐项一致；
        // 枚举在 TS 侧经 `enums: String` 归一化为 proto 枚举名，这里做同样的映射。
        Params::ReadResourceSnapshot(p) => json!([
            "readResourceSnapshot",
            resource_kind_name(p.kind),
            resource_scope_name(p.scope),
            p.workspace_id,
            p.relative_dir,
            p.name,
            p.relative_path,
            p.expected_sha256
        ]),
        Params::WriteResourceFile(p) => json!([
            "writeResourceFile",
            resource_kind_name(p.kind),
            resource_scope_name(p.scope),
            p.workspace_id,
            p.relative_dir,
            p.name,
            p.relative_path,
            bytes_value(&p.contents),
            p.expected_sha256
        ]),
        // 与 packages/runner-protocol/src/index.ts 的 deleteWorkspacePaths 分支一致。
        Params::DeleteWorkspacePaths(p) => json!(["deleteWorkspacePaths", p.relative_paths]),
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

// protobufjs `enums: String` 会把已知枚举值渲染为名称；未知值渲染为原始数字。
// Rust 侧必须产生同样的 JSON，否则 params_sha256 校验会误判；名称直接取 prost
// 生成枚举的 `as_str_name()`（与 proto 单一事实源一致）。
fn resource_kind_name(value: i32) -> Value {
    crate::proto::nova::runner::v1::ResourceKind::try_from(value)
        .map(|kind| json!(kind.as_str_name()))
        .unwrap_or_else(|_| json!(value))
}

fn resource_scope_name(value: i32) -> Value {
    crate::proto::nova::runner::v1::ResourceScope::try_from(value)
        .map(|scope| json!(scope.as_str_name()))
        .unwrap_or_else(|_| json!(value))
}

#[allow(dead_code)]
fn decode_operation(
    bytes: &[u8],
) -> Result<crate::proto::nova::runner::v1::Operation, prost::DecodeError> {
    Operation::decode(bytes)
}

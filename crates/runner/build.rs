fn main() {
    // runner.proto imports execution.proto + common.proto; all three are compiled from the
    // shared include dir. Only the client side exists here — the Runner connects out (docs/runner.md §4).
    tonic_build::configure()
        .build_client(true)
        .build_server(false)
        // The RPC itself is named Connect. Disable tonic's convenience
        // `RunnerConnectionClient::connect(endpoint)` constructor to avoid a generated
        // name collision; connection.rs constructs the Channel explicitly.
        .build_transport(false)
        .compile_protos(&["../../proto/runner.proto"], &["../../proto"])
        .expect("failed to compile proto/runner.proto");
    println!("cargo:rerun-if-changed=../../proto/common.proto");
    println!("cargo:rerun-if-changed=../../proto/execution.proto");
    println!("cargo:rerun-if-changed=../../proto/runner.proto");
}

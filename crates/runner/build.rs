fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path()
        .expect("failed to locate the vendored protoc binary");
    // Keep protobuf generation independent of tools installed on the build host.
    // This is required for the Linux, macOS and Windows release jobs to be reproducible.
    unsafe { std::env::set_var("PROTOC", protoc) };

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

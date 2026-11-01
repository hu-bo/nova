fn main() -> Result<(), Box<dyn std::error::Error>> {
    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    // SAFETY: build script sets the compiler executable before prost-build starts.
    unsafe { std::env::set_var("PROTOC", protoc) };
    prost_build::Config::new().compile_protos(
        &[
            "../../proto/runner/v1/common.proto",
            "../../proto/runner/v1/execution.proto",
            "../../proto/runner/v1/runner.proto",
        ],
        &["../../proto"],
    )?;
    println!("cargo:rerun-if-changed=../../proto/runner/v1/common.proto");
    println!("cargo:rerun-if-changed=../../proto/runner/v1/execution.proto");
    println!("cargo:rerun-if-changed=../../proto/runner/v1/runner.proto");
    Ok(())
}

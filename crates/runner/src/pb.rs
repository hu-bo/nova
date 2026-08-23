//! Generated protobuf/gRPC bindings. `nova.runner.v1` is the Connect stream contract
//! (proto/runner.proto), `nova.execution.v1` holds the execution + filesystem messages it
//! carries, and `nova.common.v1` the shared Error type.
//!
//! `nova.runner.v1` and `nova.execution.v1` cross-reference `nova.common.v1.Error` (and
//! prost-build's default well-known-type handling for everything else, e.g.
//! `google.protobuf.Empty` → `()`, `google.protobuf.Timestamp` → `::prost_types::Timestamp`).
//! Generated code resolves those cross-references with a path relative to its own package
//! depth (`super::super::common::v1`), which only lines up if all three packages are mounted
//! as nested modules under a shared `nova` ancestor exactly mirroring their dotted names —
//! hence the extra nesting here instead of the flatter `pb::common` / `pb::execution` one
//! might reach for first.

mod nova {
    pub mod common {
        pub mod v1 {
            tonic::include_proto!("nova.common.v1");
        }
    }
    pub mod execution {
        pub mod v1 {
            tonic::include_proto!("nova.execution.v1");
        }
    }
    pub mod runner {
        pub mod v1 {
            tonic::include_proto!("nova.runner.v1");
        }
    }
}

pub use nova::common::v1 as common;
pub use nova::execution::v1 as execution;
pub use nova::runner::v1 as runner;

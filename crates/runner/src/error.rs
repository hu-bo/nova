//! Shared error vocabulary for the whole crate. Reuses the wire-level `common.v1.ErrorCode`
//! directly instead of inventing a parallel Rust enum. Errors travel in-band on the Connect
//! stream (docs/proto.md §4.2): file-side request failures as `RunnerEnvelope.error`
//! (correlated by `request_id`), Execute rejections as `Finished.error`.

use crate::pb::common::ErrorCode;

#[derive(Debug, Clone)]
pub struct RunnerError {
    pub code: ErrorCode,
    pub message: String,
}

impl RunnerError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn out_of_workspace(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OutOfWorkspace, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Busy, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }

    pub fn into_wire(self) -> crate::pb::common::Error {
        crate::pb::common::Error {
            code: self.code as i32,
            message: self.message,
        }
    }
}

/// `std::io::Error` doesn't know about workspace boundaries, so callers that already know
/// better (NOT_FOUND, PERMISSION, ...) should map explicitly. This is the fallback for the rest.
impl From<std::io::Error> for RunnerError {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let code = match err.kind() {
            ErrorKind::NotFound => ErrorCode::NotFound,
            ErrorKind::PermissionDenied => ErrorCode::Permission,
            ErrorKind::AlreadyExists => ErrorCode::Exists,
            ErrorKind::IsADirectory => ErrorCode::IsDir,
            ErrorKind::NotADirectory => ErrorCode::NotDir,
            _ => ErrorCode::Io,
        };
        Self::new(code, err.to_string())
    }
}

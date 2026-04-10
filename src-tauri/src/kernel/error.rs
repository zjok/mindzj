use serde::Serialize;
use thiserror::Error;

/// Central error type for all kernel operations.
/// Each variant maps to a specific failure domain, making error handling
/// precise and debuggable across the entire backend.
#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum KernelError {
    #[error("Vault not found: {0}")]
    VaultNotFound(String),

    #[error("Vault already open: {0}")]
    VaultAlreadyOpen(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("File already exists: {0}")]
    FileAlreadyExists(String),

    #[error("Path traversal denied: {0}")]
    PathTraversalDenied(String),

    #[error("Invalid file name: {0}")]
    InvalidFileName(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Index error: {0}")]
    Index(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Authentication failed: {0}")]
    AuthFailed(String),

    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    #[error("Plugin error: {0}")]
    Plugin(String),

    #[error("AI provider error: {0}")]
    AiProvider(String),

    #[error("Configuration error: {0}")]
    Config(String),
}

/// Serializable error wrapper for Tauri command responses.
/// Tauri requires command errors to implement `Serialize` so they
/// can cross the IPC boundary to the frontend.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl From<KernelError> for CommandError {
    fn from(err: KernelError) -> Self {
        let code = match &err {
            KernelError::VaultNotFound(_) => "VAULT_NOT_FOUND",
            KernelError::VaultAlreadyOpen(_) => "VAULT_ALREADY_OPEN",
            KernelError::FileNotFound(_) => "FILE_NOT_FOUND",
            KernelError::FileAlreadyExists(_) => "FILE_ALREADY_EXISTS",
            KernelError::PathTraversalDenied(_) => "PATH_TRAVERSAL_DENIED",
            KernelError::InvalidFileName(_) => "INVALID_FILE_NAME",
            KernelError::Io(_) => "IO_ERROR",
            KernelError::Database(_) => "DATABASE_ERROR",
            KernelError::Index(_) => "INDEX_ERROR",
            KernelError::Serialization(_) => "SERIALIZATION_ERROR",
            KernelError::AuthFailed(_) => "AUTH_FAILED",
            KernelError::PermissionDenied(_) => "PERMISSION_DENIED",
            KernelError::Plugin(_) => "PLUGIN_ERROR",
            KernelError::AiProvider(_) => "AI_PROVIDER_ERROR",
            KernelError::Config(_) => "CONFIG_ERROR",
        };
        CommandError {
            code: code.to_string(),
            message: err.to_string(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

pub type KernelResult<T> = Result<T, KernelError>;

use crate::kernel::error::CommandError;
use crate::kernel::types::{
    AiProviderType, AppSettings, GlobalWindowState, HotkeyBinding, Theme, ViewMode, WorkspaceState,
};
use crate::kernel::AppState;
use keyring::{Entry, Error as KeyringError};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use tauri::{LogicalPosition, LogicalSize, Manager, State};

const MIN_RESTORED_WINDOW_WIDTH: u32 = 320;
const MIN_RESTORED_WINDOW_HEIGHT: u32 = 240;
const MAX_REASONABLE_WINDOW_COORD: i32 = 10000;
const AI_KEYRING_SERVICE: &str = "MindZJ AI";

fn sanitize_window_state(mut state: GlobalWindowState) -> GlobalWindowState {
    if matches!(state.width, Some(width) if width < MIN_RESTORED_WINDOW_WIDTH) {
        state.width = None;
    }
    if matches!(state.height, Some(height) if height < MIN_RESTORED_WINDOW_HEIGHT) {
        state.height = None;
    }
    if matches!(state.x, Some(x) if x.abs() > MAX_REASONABLE_WINDOW_COORD)
        || matches!(state.y, Some(y) if y.abs() > MAX_REASONABLE_WINDOW_COORD)
    {
        state.x = None;
        state.y = None;
    }
    state
}

fn parse_ai_provider_type(provider: &str) -> Option<AiProviderType> {
    match provider.trim() {
        "Ollama" | "ollama" => Some(AiProviderType::Ollama),
        "LMStudio" | "LM Studio" | "lmstudio" | "lm-studio" => Some(AiProviderType::LMStudio),
        "ApiKeyLLM" | "API Key LLM" | "api-key-llm" | "apikeyllm" => {
            Some(AiProviderType::ApiKeyLLM)
        }
        "Claude" | "claude" => Some(AiProviderType::Claude),
        "OpenAI" | "openai" => Some(AiProviderType::OpenAI),
        "Custom" | "custom" => Some(AiProviderType::Custom),
        _ => None,
    }
}

fn ai_keyring_account(provider: &str) -> String {
    format!("provider:{}", provider.trim())
}

fn provider_matches_config(
    provider: &str,
    config_id: Option<&str>,
    provider_type: &AiProviderType,
) -> bool {
    let trimmed = provider.trim();
    if let Some(id) = config_id {
        return id == trimmed;
    }
    match parse_ai_provider_type(trimmed) {
        Some(parsed) => &parsed == provider_type,
        None => false,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatCompletionRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGetJsonRequest {
    url: String,
    headers: Option<HashMap<String, String>>,
}

fn validate_ai_url(url: &str) -> Result<(), CommandError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(CommandError {
            code: "INVALID_AI_ENDPOINT".into(),
            message: "AI endpoint must start with http:// or https://".into(),
        });
    }
    Ok(())
}

fn build_ai_headers(
    custom_headers: Option<HashMap<String, String>>,
    include_content_type: bool,
) -> Result<HeaderMap, CommandError> {
    let mut headers = HeaderMap::new();
    if include_content_type {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    if let Some(custom_headers) = custom_headers {
        for (name, value) in custom_headers {
            let header_name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|e| CommandError {
                    code: "INVALID_AI_HEADER".into(),
                    message: e.to_string(),
                })?;
            let header_value = HeaderValue::from_str(&value).map_err(|e| CommandError {
                code: "INVALID_AI_HEADER".into(),
                message: e.to_string(),
            })?;
            headers.insert(header_name, header_value);
        }
    }
    Ok(headers)
}

// ---------------------------------------------------------------------------
// Window state persistence helpers (shared between setup hook and commands)
// ---------------------------------------------------------------------------

/// Read the persisted window state from disk. Returns `None` if the file
/// doesn't exist or cannot be parsed.
pub fn load_window_state_sync(app: &tauri::AppHandle) -> Option<GlobalWindowState> {
    let app_dir = app.path().app_data_dir().ok()?;
    let state_path = app_dir.join("window-state.json");
    if !state_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&state_path).ok()?;
    serde_json::from_str::<GlobalWindowState>(&content)
        .ok()
        .map(sanitize_window_state)
}

/// Apply a window state to the given webview window. Called BEFORE the
/// window becomes visible to avoid a visible resize flash.
pub fn apply_window_state(window: &tauri::WebviewWindow, state: &GlobalWindowState) {
    let state = sanitize_window_state(state.clone());
    if let (Some(w), Some(h)) = (state.width, state.height) {
        if w > 0 && h > 0 {
            let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
        }
    }
    if let (Some(x), Some(y)) = (state.x, state.y) {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
    }
    if state.maximized == Some(true) {
        let _ = window.maximize();
    }
}

/// Get current application settings for the vault in the calling window.
#[tauri::command]
pub async fn get_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<AppSettings, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    let s = ctx.settings.read().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire settings lock".into(),
    })?;
    Ok(s.clone())
}

/// Update application settings (full replace + persist).
#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    settings: AppSettings,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        *s = settings;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn get_ai_api_key(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    provider: String,
) -> Result<Option<String>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let settings = ctx.settings.read().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        let key = settings
            .ai_provider
            .as_ref()
            .filter(|config| {
                provider_matches_config(
                    &provider,
                    config.id.as_deref(),
                    &config.provider_type,
                )
            })
            .and_then(|config| config.api_key.clone())
            .or_else(|| {
                settings
                    .ai_custom_providers
                    .iter()
                    .find(|config| {
                        provider_matches_config(
                            &provider,
                            config.id.as_deref(),
                            &config.provider_type,
                        )
                    })
                    .and_then(|config| config.api_key.clone())
            })
            .filter(|value| !value.trim().is_empty());
        if key.is_some() {
            return Ok(key);
        }
    }

    let legacy_entry = Entry::new(AI_KEYRING_SERVICE, &ai_keyring_account(&provider)).ok();
    let legacy_key = legacy_entry
        .as_ref()
        .and_then(|entry| match entry.get_password() {
            Ok(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
            Ok(_) | Err(KeyringError::NoEntry) | Err(_) => None,
        });
    if let Some(key) = legacy_key {
        {
            let mut settings = ctx.settings.write().map_err(|_| CommandError {
                code: "LOCK_ERROR".into(),
                message: "Failed to acquire settings lock".into(),
            })?;
            if let Some(config) = settings.ai_provider.as_mut() {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    config.api_key = Some(key.clone());
                    config.has_api_key = true;
                }
            }
            for config in settings.ai_custom_providers.iter_mut() {
                if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                    config.api_key = Some(key.clone());
                    config.has_api_key = true;
                }
            }
        }
        ctx.save_settings().map_err(CommandError::from)?;
        if let Some(entry) = legacy_entry {
            let _ = entry.delete_credential();
        }
        return Ok(Some(key));
    }

    Ok(None)
}

#[tauri::command]
pub async fn set_ai_api_key(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    provider: String,
    api_key: Option<String>,
) -> Result<(), CommandError> {
    let value = api_key
        .unwrap_or_default()
        .trim()
        .to_string();
    let stored = if value.is_empty() { None } else { Some(value) };
    let has_api_key = stored.is_some();
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut settings = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        if let Some(config) = settings.ai_provider.as_mut() {
            if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                config.api_key = stored.clone();
                config.has_api_key = has_api_key;
            }
        }
        for config in settings.ai_custom_providers.iter_mut() {
            if provider_matches_config(&provider, config.id.as_deref(), &config.provider_type) {
                config.api_key = stored.clone();
                config.has_api_key = has_api_key;
            }
        }
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_completion(request: AiChatCompletionRequest) -> Result<Value, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, true)?;

    let response = reqwest::Client::new()
        .post(url)
        .headers(headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: format!(
                "{}{}",
                status.as_u16(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {}", text)
                }
            ),
        });
    }

    serde_json::from_str(&text).map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid AI response JSON: {}", e),
    })
}

#[tauri::command]
pub async fn ai_get_json(request: AiGetJsonRequest) -> Result<Value, CommandError> {
    let url = request.url.trim();
    validate_ai_url(url)?;
    let headers = build_ai_headers(request.headers, false)?;

    let response = reqwest::Client::new()
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: e.to_string(),
        })?;

    let status = response.status();
    let text = response.text().await.map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: e.to_string(),
    })?;

    if !status.is_success() {
        return Err(CommandError {
            code: "AI_PROVIDER_ERROR".into(),
            message: format!(
                "{}{}",
                status.as_u16(),
                if text.is_empty() {
                    String::new()
                } else {
                    format!(": {}", text)
                }
            ),
        });
    }

    serde_json::from_str(&text).map_err(|e| CommandError {
        code: "AI_PROVIDER_ERROR".into(),
        message: format!("Invalid AI response JSON: {}", e),
    })
}

/// Update the active skin. Accepts either the legacy `Light`/`Dark`/
/// `System` enum payload or a free-form string (built-in skin ID like
/// `"github-dark"` or a `"custom:<name>"` reference to a user-imported
/// theme).
#[tauri::command]
pub async fn set_theme(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    theme: Theme,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.theme = theme.as_id();
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

/// Update font size.
#[tauri::command]
pub async fn set_font_size(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    size: u32,
) -> Result<(), CommandError> {
    if size < 8 || size > 72 {
        return Err(CommandError {
            code: "INVALID_VALUE".into(),
            message: "Font size must be between 8 and 72".into(),
        });
    }
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.font_size = size;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

/// Update default view mode.
#[tauri::command]
pub async fn set_view_mode(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    mode: ViewMode,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    {
        let mut s = ctx.settings.write().map_err(|_| CommandError {
            code: "LOCK_ERROR".into(),
            message: "Failed to acquire settings lock".into(),
        })?;
        s.default_view_mode = mode;
    }
    ctx.save_settings().map_err(CommandError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Workspace commands
// ---------------------------------------------------------------------------

/// Load workspace state from .mindzj/workspace.json
#[tauri::command]
pub async fn load_workspace(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<WorkspaceState, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.load_workspace().map_err(CommandError::from)
}

/// Save workspace state to .mindzj/workspace.json
#[tauri::command]
pub async fn save_workspace(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    workspace: WorkspaceState,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.save_workspace(&workspace).map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Hotkey commands
// ---------------------------------------------------------------------------

/// Load custom hotkey bindings from .mindzj/hotkeys.json
#[tauri::command]
pub async fn get_hotkeys(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<HotkeyBinding>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.load_hotkeys().map_err(CommandError::from)
}

/// Save custom hotkey bindings to .mindzj/hotkeys.json
#[tauri::command]
pub async fn save_hotkeys(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    bindings: Vec<HotkeyBinding>,
) -> Result<(), CommandError> {
    let ctx = state.get_vault_context(window.label())?;
    ctx.save_hotkeys(&bindings).map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Global window state commands (not per-vault)
// ---------------------------------------------------------------------------

/// Load global window state from app data directory.
/// This is shared across ALL vaults so the window always restores to the same
/// position/size regardless of which vault is opened.
#[tauri::command]
pub async fn get_window_state(app: tauri::AppHandle) -> Result<GlobalWindowState, CommandError> {
    let app_dir = app.path().app_data_dir().map_err(|e| CommandError {
        code: "PATH_ERROR".into(),
        message: e.to_string(),
    })?;
    let state_path = app_dir.join("window-state.json");
    if state_path.exists() {
        let content = std::fs::read_to_string(&state_path).map_err(|e| CommandError {
            code: "IO_ERROR".into(),
            message: e.to_string(),
        })?;
        serde_json::from_str(&content).map_err(|e| CommandError {
            code: "PARSE_ERROR".into(),
            message: e.to_string(),
        })
    } else {
        Ok(GlobalWindowState::default())
    }
}

/// Save global window state to app data directory.
/// Merges with existing state so partial updates (e.g. maximized-only) preserve
/// the previous position/size values.
#[tauri::command]
pub async fn save_window_state(
    app: tauri::AppHandle,
    window_state: GlobalWindowState,
) -> Result<(), CommandError> {
    let app_dir = app.path().app_data_dir().map_err(|e| CommandError {
        code: "PATH_ERROR".into(),
        message: e.to_string(),
    })?;
    std::fs::create_dir_all(&app_dir).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
    })?;
    let state_path = app_dir.join("window-state.json");
    // Read existing state to merge with incoming partial update
    let mut merged = if state_path.exists() {
        std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|c| serde_json::from_str::<GlobalWindowState>(&c).ok())
            .unwrap_or_default()
    } else {
        GlobalWindowState::default()
    };
    // Merge: only overwrite fields that are Some in the incoming state
    if window_state.x.is_some() {
        merged.x = window_state.x;
    }
    if window_state.y.is_some() {
        merged.y = window_state.y;
    }
    if window_state.width.is_some() {
        merged.width = window_state.width;
    }
    if window_state.height.is_some() {
        merged.height = window_state.height;
    }
    if window_state.maximized.is_some() {
        merged.maximized = window_state.maximized;
    }
    let merged = sanitize_window_state(merged);
    let json = serde_json::to_string_pretty(&merged).map_err(|e| CommandError {
        code: "SERIALIZE_ERROR".into(),
        message: e.to_string(),
    })?;
    std::fs::write(&state_path, json).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: e.to_string(),
    })?;
    Ok(())
}

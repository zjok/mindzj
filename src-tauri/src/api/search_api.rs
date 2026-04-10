use crate::kernel::error::CommandError;
use crate::kernel::types::{GraphData, NoteLink, SearchQuery, SearchResult};
use crate::kernel::AppState;
use tauri::State;

// ---------------------------------------------------------------------------
// Search commands
// ---------------------------------------------------------------------------

/// Full-text search across the vault in the calling window.
#[tauri::command]
pub async fn search_vault(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    query: String,
    limit: Option<usize>,
    extension_filter: Option<String>,
    path_filter: Option<String>,
) -> Result<Vec<SearchResult>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;

    let search_query = SearchQuery {
        text: query,
        limit: limit.unwrap_or(20),
        extension_filter,
        path_filter,
    };

    let search_index = ctx.search_index.lock().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire search index lock".into(),
    })?;

    search_index.search(&search_query).map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// Link commands
// ---------------------------------------------------------------------------

/// Get all outgoing links from a file.
#[tauri::command]
pub async fn get_forward_links(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<Vec<NoteLink>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;

    let link_index = ctx.link_index.lock().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire link index lock".into(),
    })?;

    Ok(link_index.get_forward_links(&relative_path))
}

/// Get all incoming links (backlinks) to a file.
#[tauri::command]
pub async fn get_backlinks(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    relative_path: String,
) -> Result<Vec<NoteLink>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;

    let link_index = ctx.link_index.lock().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire link index lock".into(),
    })?;

    Ok(link_index.get_backlinks(&relative_path))
}

/// Get graph data for the graph view.
#[tauri::command]
pub async fn get_graph_data(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<GraphData, CommandError> {
    let ctx = state.get_vault_context(window.label())?;

    let link_index = ctx.link_index.lock().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire link index lock".into(),
    })?;

    Ok(link_index.build_graph())
}

/// Get all unresolved links in the vault.
#[tauri::command]
pub async fn get_unresolved_links(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<NoteLink>, CommandError> {
    let ctx = state.get_vault_context(window.label())?;

    let link_index = ctx.link_index.lock().map_err(|_| CommandError {
        code: "LOCK_ERROR".into(),
        message: "Failed to acquire link index lock".into(),
    })?;

    Ok(link_index.get_unresolved_links())
}

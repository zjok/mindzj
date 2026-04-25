use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Vault types
// ---------------------------------------------------------------------------

/// A vault is a root directory containing the user's notes, config, and index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultInfo {
    /// Display name of the vault
    pub name: String,
    /// Absolute path on the filesystem
    pub path: PathBuf,
    /// When the vault was first opened by MindZJ
    pub created_at: DateTime<Utc>,
    /// Last time the vault was accessed
    pub last_opened: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// File system types
// ---------------------------------------------------------------------------

/// Represents a single entry (file or directory) inside a vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntry {
    /// File/directory name with extension
    pub name: String,
    /// Path relative to the vault root
    pub relative_path: String,
    /// True if this entry is a directory
    pub is_dir: bool,
    /// File size in bytes (0 for directories)
    pub size: u64,
    /// Last modified time
    pub modified: DateTime<Utc>,
    /// File extension (e.g. "md", "mindzj"), empty for dirs
    pub extension: String,
    /// Children entries (populated only for directories in tree queries)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<VaultEntry>>,
}

/// Metadata for a single file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub relative_path: String,
    pub size: u64,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub is_markdown: bool,
    pub word_count: u32,
    pub char_count: u32,
    pub tags: Vec<String>,
    pub backlink_count: u32,
}

/// Events emitted by the file system watcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FileEvent {
    Created { path: String },
    Modified { path: String },
    Deleted { path: String },
    Renamed { from: String, to: String },
}

// ---------------------------------------------------------------------------
// Link types
// ---------------------------------------------------------------------------

/// Represents a link from one note to another.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteLink {
    /// Path of the source file (where the link is written)
    pub source: String,
    /// Path of the target file (what the link points to)
    pub target: String,
    /// Display text of the link (if any)
    pub display_text: Option<String>,
    /// Type of link
    pub link_type: LinkType,
    /// Line number where the link appears in the source file
    pub line: u32,
    /// Column offset
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LinkType {
    /// [[target]] or [[target|display]]
    WikiLink,
    /// [display](target.md)
    MarkdownLink,
    /// ![[target]] embedded content
    Embed,
}

/// Data for the graph view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    pub path: String,
    /// Number of links pointing to this node
    pub backlink_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub link_type: LinkType,
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub text: String,
    /// Maximum number of results to return
    pub limit: usize,
    /// Filter by file extension
    pub extension_filter: Option<String>,
    /// Filter by directory path prefix
    pub path_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub path: String,
    pub file_name: String,
    /// Matching text snippets with context
    pub snippets: Vec<SearchSnippet>,
    /// Relevance score (0.0 - 1.0)
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSnippet {
    pub text: String,
    pub line: u32,
    /// Start and end offsets of the match within the snippet text
    pub highlight_start: u32,
    pub highlight_end: u32,
}

// ---------------------------------------------------------------------------
// Editor types (passed between backend and frontend)
// ---------------------------------------------------------------------------

/// Content of a file being edited.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub modified: DateTime<Utc>,
    /// SHA-256 hash of the content (for conflict detection)
    pub hash: String,
}

/// Outline heading extracted from a markdown file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct OutlineHeading {
    pub level: u8,
    pub text: String,
    pub line: u32,
}

// ---------------------------------------------------------------------------
// Settings types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// Active skin ID. Was originally a `Theme` enum with just
    /// `Light`/`Dark`/`System`; widened to a free-form string so
    /// built-in preset skins ("github-dark", "nord", ...) and
    /// per-vault custom skins (`custom:<name>`) can coexist with
    /// the original three values without a schema migration.
    ///
    /// The frontend resolves the string into a `data-theme`
    /// attribute and — for `custom:<name>` IDs — injects the
    /// matching CSS file from `.mindzj/themes/<name>.css`.
    #[serde(default = "default_theme", deserialize_with = "deserialize_theme")]
    pub theme: String,
    pub font_size: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_show_markdown_toolbar")]
    pub show_markdown_toolbar: bool,
    pub editor_line_numbers: bool,
    pub editor_word_wrap: bool,
    pub editor_vim_mode: bool,
    #[serde(default)]
    pub editor_spell_check: bool,
    #[serde(default = "default_true")]
    pub editor_readable_line_length: bool,
    pub auto_save_interval_ms: u32,
    pub default_view_mode: ViewMode,
    pub locale: String,
    // Appearance
    #[serde(default)]
    pub accent_color: Option<String>,
    // Per-element color overrides. None = use the theme default.
    // Set via Settings → Appearance → Custom colors, each with a
    // reset-to-default button.
    #[serde(default)]
    pub heading_color: Option<String>,
    #[serde(default)]
    pub link_color: Option<String>,
    #[serde(default)]
    pub highlight_color: Option<String>,
    /// Bold (`**text**`) color. Feeds the `--mz-syntax-bold` CSS
    /// variable that source, live-preview, and reading modes share.
    #[serde(default)]
    pub bold_color: Option<String>,
    /// Render bare URLs (e.g. `github.com/zjok/mindzj`) as clickable
    /// links in reading + live-preview mode. Defaults to true; when
    /// false the same text renders unstyled and non-interactive.
    #[serde(default = "default_true")]
    pub auto_link_urls: bool,
    #[serde(default)]
    pub css_snippet: Option<String>,
    /// Names of enabled CSS snippet files under `.mindzj/snippets/`.
    /// The snippet contents themselves live as `.css` files on disk —
    /// this array just tracks which ones are currently applied.
    /// Matches Obsidian's appearance.json snippet model.
    #[serde(default)]
    pub enabled_css_snippets: Vec<String>,
    // Files & Links
    #[serde(default = "default_attachment_folder")]
    pub attachment_folder: String,
    #[serde(default = "default_true")]
    pub auto_update_links: bool,
    #[serde(default)]
    pub default_new_note_location: NewNoteLocation,
    // Templates
    #[serde(default)]
    pub template_folder: Option<String>,
    // AI
    pub ai_provider: Option<AiProviderConfig>,
    #[serde(default = "default_image_resize_options")]
    pub image_resize_options: String,
    #[serde(default = "default_image_ctrl_click")]
    pub image_ctrl_click: String,
    #[serde(default = "default_true")]
    pub image_wheel_zoom: bool,
    #[serde(default = "default_image_wheel_modifier")]
    pub image_wheel_modifier: String,
    #[serde(default = "default_image_wheel_zoom_step")]
    pub image_wheel_zoom_step: u32,
    #[serde(default)]
    pub image_wheel_invert: bool,
}

fn default_true() -> bool { true }
fn default_attachment_folder() -> String { ".mindzj/images".to_string() }
fn default_show_markdown_toolbar() -> bool { true }
fn default_theme() -> String { "dark".to_string() }

/// Accept both the historical JSON shapes and the new one:
///   - Legacy enum-style values serialized as `"Light"` / `"Dark"` /
///     `"System"` (or any casing — we normalize to lowercase).
///   - Legacy lowercase `"light"` / `"dark"` / `"system"`.
///   - New free-form skin IDs like `"github-dark"`, `"nord"`, or
///     `"custom:my-theme"` — passed through unchanged.
///
/// A null or missing value falls back to the `default_theme()` ("dark").
fn deserialize_theme<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(normalize_theme(opt))
}

fn normalize_theme(value: Option<String>) -> String {
    let raw = match value {
        Some(v) => v,
        None => return default_theme(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default_theme();
    }
    match trimmed {
        "Light" | "light" => "light".to_string(),
        "Dark" | "dark" => "dark".to_string(),
        "System" | "system" => "system".to_string(),
        other => other.to_string(),
    }
}
fn default_font_family() -> String {
    "\"Inter\", \"Segoe UI\", -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans\", Ubuntu, Cantarell, sans-serif".to_string()
}
fn default_image_resize_options() -> String { "25%, 33%, 50%, 100%".to_string() }
fn default_image_ctrl_click() -> String { "open-in-new-tab".to_string() }
fn default_image_wheel_modifier() -> String { "Alt".to_string() }
fn default_image_wheel_zoom_step() -> u32 { 20 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            font_size: 16,
            font_family: default_font_family(),
            show_markdown_toolbar: default_show_markdown_toolbar(),
            editor_line_numbers: false,
            editor_word_wrap: true,
            editor_vim_mode: false,
            editor_spell_check: false,
            editor_readable_line_length: true,
            auto_save_interval_ms: 2000,
            default_view_mode: ViewMode::LivePreview,
            // Default UI language is English. When a user creates a
            // brand-new vault this is what gets written into its
            // `.mindzj/settings.json`. Must stay in sync with
            // DEFAULT_SETTINGS.locale on the JS side.
            locale: "en".to_string(),
            accent_color: None,
            heading_color: None,
            link_color: None,
            highlight_color: None,
            bold_color: None,
            auto_link_urls: true,
            css_snippet: None,
            enabled_css_snippets: Vec::new(),
            attachment_folder: ".mindzj/images".to_string(),
            auto_update_links: true,
            default_new_note_location: NewNoteLocation::VaultRoot,
            template_folder: None,
            ai_provider: None,
            image_resize_options: default_image_resize_options(),
            image_ctrl_click: default_image_ctrl_click(),
            image_wheel_zoom: true,
            image_wheel_modifier: default_image_wheel_modifier(),
            image_wheel_zoom_step: default_image_wheel_zoom_step(),
            image_wheel_invert: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum NewNoteLocation {
    VaultRoot,
    SameFolder,
    Custom(String),
}

impl Default for NewNoteLocation {
    fn default() -> Self { Self::VaultRoot }
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
    #[serde(default)]
    pub primary_pane_path: Option<String>,
    #[serde(default)]
    pub secondary_pane_path: Option<String>,
    #[serde(default)]
    pub active_pane_slot: Option<String>,
    #[serde(default)]
    pub split_direction: Option<String>,
    #[serde(default)]
    pub split_ratio: Option<f64>,
    pub sidebar_tab: String,
    pub sidebar_collapsed: bool,
    pub sidebar_width: u32,
    #[serde(default)]
    pub sidebar_tab_order: Vec<String>,
    #[serde(default)]
    pub file_scroll_positions: HashMap<String, HashMap<String, u32>>,
    #[serde(default)]
    pub file_top_lines: HashMap<String, u32>,
    #[serde(default)]
    pub file_view_modes: HashMap<String, String>,
    #[serde(default)]
    pub file_last_non_reading_view_modes: HashMap<String, String>,
    // Window geometry - persisted so the window reopens at the same position/size
    #[serde(default)]
    pub window_x: Option<i32>,
    #[serde(default)]
    pub window_y: Option<i32>,
    #[serde(default)]
    pub window_width: Option<u32>,
    #[serde(default)]
    pub window_height: Option<u32>,
    #[serde(default)]
    pub window_maximized: Option<bool>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            open_files: Vec::new(),
            active_file: None,
            primary_pane_path: None,
            secondary_pane_path: None,
            active_pane_slot: Some("primary".to_string()),
            split_direction: Some("right".to_string()),
            split_ratio: Some(0.5),
            sidebar_tab: "files".to_string(),
            sidebar_collapsed: false,
            sidebar_width: 260,
            sidebar_tab_order: Vec::new(),
            file_scroll_positions: HashMap::new(),
            file_top_lines: HashMap::new(),
            file_view_modes: HashMap::new(),
            file_last_non_reading_view_modes: HashMap::new(),
            window_x: None,
            window_y: None,
            window_width: None,
            window_height: None,
            window_maximized: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Hotkey types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyBinding {
    pub command: String,
    pub keys: String,
}

/// Deprecated placeholder kept for command signatures that still take a
/// "theme" parameter. The active skin is now a free-form string (see
/// `AppSettings::theme`), but the `set_theme` Tauri command continues to
/// accept the legacy enum payload so older frontends still work. New
/// code should call `update_settings` with the full `AppSettings`
/// struct — `set_theme` is only used by the legacy frontend path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Theme {
    /// Free-form string (preferred) — accepts all built-in and custom IDs.
    Str(String),
    /// Legacy tagged enum form for older persisted settings.
    Tag(ThemeTag),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThemeTag {
    #[serde(alias = "light")]
    Light,
    #[serde(alias = "dark")]
    Dark,
    #[serde(alias = "system")]
    System,
}

impl Theme {
    /// Collapse any variant into the canonical string ID stored in
    /// `AppSettings::theme`.
    pub fn as_id(&self) -> String {
        match self {
            Theme::Str(s) => normalize_theme(Some(s.clone())),
            Theme::Tag(ThemeTag::Light) => "light".to_string(),
            Theme::Tag(ThemeTag::Dark) => "dark".to_string(),
            Theme::Tag(ThemeTag::System) => "system".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ViewMode {
    Source,
    LivePreview,
    Reading,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderConfig {
    pub provider_type: AiProviderType,
    /// API endpoint (e.g., "http://localhost:11434" for Ollama)
    pub endpoint: Option<String>,
    /// API key (stored encrypted in system keyring, not here)
    pub has_api_key: bool,
    /// Model name (e.g., "llama3.2", "claude-sonnet-4-20250514")
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AiProviderType {
    Ollama,
    LMStudio,
    Claude,
    OpenAI,
    Custom,
}

// ---------------------------------------------------------------------------
// Global window state (not per-vault — shared across all vaults)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalWindowState {
    #[serde(default)]
    pub x: Option<i32>,
    #[serde(default)]
    pub y: Option<i32>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub maximized: Option<bool>,
}

impl Default for GlobalWindowState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: None,
            height: None,
            maximized: None,
        }
    }
}

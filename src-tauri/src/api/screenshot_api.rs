//! Screenshot API
//!
//! Provides screen capture functionality for the MindZJ screenshot tool.
//! Uses the `xcap` crate for cross-platform screen capture and returns
//! the captured image as a base64-encoded PNG string.

use crate::kernel::error::CommandError;
use base64::Engine;

/// Capture the entire primary monitor and return the image as a
/// base64-encoded PNG string. The frontend uses this to display the
/// screenshot in an overlay for region selection and annotation.
#[tauri::command]
pub async fn capture_screen() -> Result<String, CommandError> {
    // Run the blocking capture on a dedicated thread so we don't block
    // the Tauri async runtime.
    let result = tokio::task::spawn_blocking(|| -> Result<String, String> {
        let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to list monitors: {}", e))?;
        let monitor = monitors
            .into_iter()
            .find(|m| m.is_primary())
            .or_else(|| xcap::Monitor::all().ok()?.into_iter().next())
            .ok_or_else(|| "No monitor found".to_string())?;

        let img = monitor
            .capture_image()
            .map_err(|e| format!("Failed to capture screen: {}", e))?;

        // Encode the captured image as PNG into a byte buffer
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("Failed to encode PNG: {}", e))?;

        Ok(base64::engine::general_purpose::STANDARD.encode(buf.into_inner()))
    })
    .await
    .map_err(|e| CommandError {
        code: "SCREENSHOT_ERROR".into(),
        message: format!("Screenshot task panicked: {}", e),
    })?;

    result.map_err(|msg| CommandError {
        code: "SCREENSHOT_ERROR".into(),
        message: msg,
    })
}

/// Save a base64-encoded PNG image to a temporary file and return the path.
/// Used by the screenshot editor to save the final annotated screenshot
/// before inserting it into the vault.
#[tauri::command]
pub async fn save_screenshot_to_temp(base64_data: String) -> Result<String, CommandError> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| CommandError {
            code: "DECODE_ERROR".into(),
            message: format!("Failed to decode base64: {}", e),
        })?;

    let temp_dir = std::env::temp_dir();
    let filename = format!(
        "mindzj_screenshot_{}.png",
        chrono::Local::now().format("%Y%m%d_%H%M%S")
    );
    let path = temp_dir.join(&filename);

    std::fs::write(&path, &data).map_err(|e| CommandError {
        code: "IO_ERROR".into(),
        message: format!("Failed to write screenshot: {}", e),
    })?;

    Ok(path.to_string_lossy().to_string())
}

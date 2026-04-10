use crate::OutputFormat;
use anyhow::{Context, Result};
use colored::Colorize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Vault commands
// ---------------------------------------------------------------------------

pub fn vault_info(vault_path: &Path, format: OutputFormat) -> Result<()> {
    let config_dir = vault_path.join(".mindzj");

    if !config_dir.exists() {
        eprintln!(
            "{} '{}' is not a MindZJ vault (no .mindzj directory).",
            "Error:".red(),
            vault_path.display()
        );
        eprintln!("Run {} to initialize.", "mindzj vault open <path>".cyan());
        std::process::exit(1);
    }

    let mut md_count = 0u32;
    let mut total_size = 0u64;
    count_files_recursive(vault_path, &mut md_count, &mut total_size)?;

    let name = vault_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let size_human = format_bytes(total_size);

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "name": name,
            "path": vault_path,
            "notes": md_count,
            "size_bytes": total_size,
            "size_human": size_human
        }))?;
        return Ok(());
    }

    println!("{}", "Vault Information".bold().underline());
    println!("  Name:     {}", name.cyan());
    println!("  Path:     {}", vault_path.display());
    println!("  Notes:    {}", md_count);
    println!("  Size:     {}", size_human);

    Ok(())
}

pub fn vault_list(format: OutputFormat) -> Result<()> {
    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "vaults": [],
            "implemented": false
        }))?;
        return Ok(());
    }

    println!("{}", "Known vaults:".bold());
    println!("  (vault history is not implemented yet)");
    Ok(())
}

pub fn vault_open(path: &Path, format: OutputFormat) -> Result<()> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

    if !path.exists() {
        fs::create_dir_all(&path)?;
        println!("Created directory: {}", path.display());
    }

    let config_dir = path.join(".mindzj");
    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)?;
    }

    for subdir in ["snapshots", "plugins", "snippets", "themes", "images"] {
        fs::create_dir_all(config_dir.join(subdir))?;
    }

    for (name, default_content) in [
        ("app.json", "{}"),
        ("appearance.json", "{}"),
        ("hotkeys.json", "[]"),
        (
            "workspace.json",
            r#"{"open_files":[],"active_file":null,"sidebar_tab":"files","sidebar_collapsed":false,"sidebar_width":260,"sidebar_tab_order":["files","outline","search","calendar"]}"#,
        ),
        ("plugins.json", "[]"),
        ("graph.json", "{}"),
        ("backlink.json", "{}"),
        ("types.json", "{}"),
        ("settings.json", r#"{"attachment_folder":".mindzj/images"}"#),
    ] {
        let file_path = config_dir.join(name);
        if !file_path.exists() {
            fs::write(file_path, default_content)?;
        }
    }

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "path": path,
            "initialized": true
        }))?;
        return Ok(());
    }

    println!(
        "{} Opened vault at {}",
        "OK".green(),
        path.display().to_string().cyan()
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Note commands
// ---------------------------------------------------------------------------

pub fn note_create(
    vault_path: &Path,
    name: &str,
    content: Option<&str>,
    read_stdin: bool,
    folder: Option<&str>,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_name = normalize_note_name(name);
    let file_path = if let Some(dir) = folder {
        let dir_path = vault_path.join(dir);
        if !dir_path.exists() {
            fs::create_dir_all(&dir_path)?;
        }
        dir_path.join(&file_name)
    } else {
        vault_path.join(&file_name)
    };

    if file_path.exists() {
        eprintln!(
            "{} File '{}' already exists.",
            "Error:".red(),
            file_path.display()
        );
        std::process::exit(1);
    }

    let input = read_content_input(content, read_stdin)?;
    let default_content = if input.is_empty() {
        format!("# {}\n\n", name.trim_end_matches(".md"))
    } else {
        input
    };

    atomic_write_string(&file_path, &default_content)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "created": true,
            "path": relative_display_path(vault_path, &file_path),
            "bytes": default_content.len()
        }))?;
        return Ok(());
    }

    println!(
        "{} Created note: {}",
        "OK".green(),
        relative_display_path(vault_path, &file_path).cyan()
    );

    Ok(())
}

pub fn note_write(
    vault_path: &Path,
    name: &str,
    content: Option<&str>,
    read_stdin: bool,
    create: bool,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_path = if create {
        match try_resolve_note_path(vault_path, name)? {
            Some(path) => path,
            None => resolve_note_destination(vault_path, name),
        }
    } else {
        resolve_note_path(vault_path, name)?
    };
    let existed_before = file_path.exists();

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let next_content = read_required_content(content, read_stdin, "write")?;
    atomic_write_string(&file_path, &next_content)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "written": true,
            "path": relative_display_path(vault_path, &file_path),
            "bytes": next_content.len(),
            "created": create && !existed_before
        }))?;
        return Ok(());
    }

    println!(
        "{} Wrote note: {}",
        "OK".green(),
        relative_display_path(vault_path, &file_path).cyan()
    );

    Ok(())
}

pub fn note_append(
    vault_path: &Path,
    name: &str,
    content: Option<&str>,
    read_stdin: bool,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_path = resolve_note_path(vault_path, name)?;
    let mut current = fs::read_to_string(&file_path)
        .with_context(|| format!("Failed to read '{}'", file_path.display()))?;
    let appended = read_required_content(content, read_stdin, "append")?;

    if !current.is_empty() && !current.ends_with('\n') {
        current.push('\n');
    }
    current.push_str(&appended);

    atomic_write_string(&file_path, &current)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "appended": true,
            "path": relative_display_path(vault_path, &file_path),
            "appended_bytes": appended.len(),
            "bytes": current.len()
        }))?;
        return Ok(());
    }

    println!(
        "{} Appended to note: {}",
        "OK".green(),
        relative_display_path(vault_path, &file_path).cyan()
    );

    Ok(())
}

pub fn note_move(
    vault_path: &Path,
    from: &str,
    to: &str,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let from_path = resolve_note_path(vault_path, from)?;
    let to_path = resolve_note_destination(vault_path, to);

    if to_path.exists() {
        eprintln!(
            "{} Destination '{}' already exists.",
            "Error:".red(),
            to_path.display()
        );
        std::process::exit(1);
    }

    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::rename(&from_path, &to_path).with_context(|| {
        format!(
            "Failed to move '{}' to '{}'",
            from_path.display(),
            to_path.display()
        )
    })?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "moved": true,
            "from": relative_display_path(vault_path, &from_path),
            "to": relative_display_path(vault_path, &to_path)
        }))?;
        return Ok(());
    }

    println!(
        "{} Moved note: {} -> {}",
        "OK".green(),
        relative_display_path(vault_path, &from_path).cyan(),
        relative_display_path(vault_path, &to_path).cyan()
    );

    Ok(())
}

pub fn note_read(vault_path: &Path, name: &str, format: OutputFormat) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_path = resolve_note_path(vault_path, name)?;
    let content = fs::read_to_string(&file_path)
        .with_context(|| format!("Failed to read '{}'", file_path.display()))?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "path": relative_display_path(vault_path, &file_path),
            "content": content
        }))?;
        return Ok(());
    }

    print!("{}", content);
    Ok(())
}

pub fn note_list(
    vault_path: &Path,
    tag_filter: Option<&str>,
    dir_filter: Option<&str>,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let base = if let Some(dir) = dir_filter {
        vault_path.join(dir)
    } else {
        vault_path.to_path_buf()
    };

    if !base.exists() {
        eprintln!(
            "{} Directory '{}' not found.",
            "Error:".red(),
            base.display()
        );
        std::process::exit(1);
    }

    let mut notes = Vec::new();
    collect_notes_recursive(&base, vault_path, &mut notes)?;

    if let Some(tag) = tag_filter {
        notes.retain(|(_, content)| content.contains(&format!("#{}", tag)));
    }

    let paths: Vec<String> = notes
        .iter()
        .map(|(path, _)| relative_display_path(vault_path, path))
        .collect();

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "count": paths.len(),
            "notes": paths
        }))?;
        return Ok(());
    }

    if paths.is_empty() {
        println!("No notes found.");
        return Ok(());
    }

    for path in &paths {
        println!("{}", path);
    }

    println!("\n{} notes total", paths.len().to_string().cyan());
    Ok(())
}

pub fn note_search(
    vault_path: &Path,
    query: &str,
    limit: usize,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let query_lower = query.to_lowercase();
    let mut results: Vec<(PathBuf, Vec<(usize, String)>)> = Vec::new();

    let mut all_notes = Vec::new();
    collect_notes_recursive(vault_path, vault_path, &mut all_notes)?;

    for (path, content) in &all_notes {
        let mut matches = Vec::new();

        for (line_num, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&query_lower) {
                matches.push((line_num + 1, line.to_string()));
            }
        }

        if !matches.is_empty() {
            results.push((path.clone(), matches));
        }
    }

    results.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
    results.truncate(limit);

    if matches!(format, OutputFormat::Json) {
        let payload: Vec<_> = results
            .iter()
            .map(|(path, matches)| {
                json!({
                    "path": relative_display_path(vault_path, path),
                    "matches": matches.iter().map(|(line, text)| {
                        json!({ "line": line, "text": text })
                    }).collect::<Vec<_>>()
                })
            })
            .collect();
        emit_json(&json!({
            "query": query,
            "matched_files": payload.len(),
            "results": payload
        }))?;
        return Ok(());
    }

    if results.is_empty() {
        println!("No results for '{}'", query);
        return Ok(());
    }

    for (path, matches) in &results {
        let relative = relative_display_path(vault_path, path);
        println!("{}", relative.cyan().bold());

        for (line_num, line) in matches.iter().take(3) {
            let trimmed = line.trim();
            let display = trimmed.replace(query, &format!("{}", query.yellow().bold()));
            println!("  L:{} {}", line_num, display);
        }

        if matches.len() > 3 {
            println!("  {} more matches...", (matches.len() - 3).to_string().dimmed());
        }

        println!();
    }

    println!("{} files matched", results.len().to_string().cyan());
    Ok(())
}

pub fn note_delete(
    vault_path: &Path,
    name: &str,
    force: bool,
    format: OutputFormat,
) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_path = resolve_note_path(vault_path, name)?;

    if !force {
        eprint!(
            "Delete '{}'? This cannot be undone. [y/N] ",
            relative_display_path(vault_path, &file_path)
        );
        io::stderr().flush()?;

        let mut input = String::new();
        io::stdin().read_line(&mut input)?;

        if !input.trim().eq_ignore_ascii_case("y") {
            println!("Cancelled.");
            return Ok(());
        }
    }

    create_delete_snapshot(vault_path, name, &file_path)?;
    fs::remove_file(&file_path)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "deleted": true,
            "path": relative_display_path(vault_path, &file_path)
        }))?;
        return Ok(());
    }

    println!("{} Deleted: {}", "OK".green(), relative_display_path(vault_path, &file_path));
    Ok(())
}

pub fn note_links(vault_path: &Path, name: &str, format: OutputFormat) -> Result<()> {
    ensure_vault(vault_path)?;

    let file_path = resolve_note_path(vault_path, name)?;
    let content = fs::read_to_string(&file_path)?;
    let mut links = Vec::new();

    let mut rest = content.as_str();
    while let Some(start) = rest.find("[[") {
        if let Some(end) = rest[start + 2..].find("]]") {
            let inner = &rest[start + 2..start + 2 + end];
            let target = inner.split('|').next().unwrap_or(inner).trim().to_string();
            links.push(target);
            rest = &rest[start + 2 + end + 2..];
        } else {
            break;
        }
    }

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "path": relative_display_path(vault_path, &file_path),
            "links": links
        }))?;
        return Ok(());
    }

    println!("{}", "Outgoing links:".bold());
    if links.is_empty() {
        println!("  (no links found)");
        return Ok(());
    }

    for link in &links {
        println!("  -> {}", link.cyan());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Config commands
// ---------------------------------------------------------------------------

pub fn config_get(vault_path: &Path, key: &str, format: OutputFormat) -> Result<()> {
    let config_path = vault_path.join(".mindzj").join("config.json");

    if !config_path.exists() {
        if matches!(format, OutputFormat::Json) {
            emit_json(&json!({ "key": key, "value": null }))?;
        } else {
            println!("(not set)");
        }
        return Ok(());
    }

    let data: serde_json::Value = serde_json::from_str(&fs::read_to_string(&config_path)?)?;
    let value = data.get(key).cloned().unwrap_or(serde_json::Value::Null);

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({ "key": key, "value": value }))?;
    } else if value.is_null() {
        println!("(not set)");
    } else {
        println!("{}", value);
    }

    Ok(())
}

pub fn config_set(vault_path: &Path, key: &str, value: &str, format: OutputFormat) -> Result<()> {
    ensure_vault(vault_path)?;

    let config_path = vault_path.join(".mindzj").join("config.json");
    let mut data: serde_json::Value = if config_path.exists() {
        serde_json::from_str(&fs::read_to_string(&config_path)?)?
    } else {
        json!({})
    };

    data[key] = serde_json::Value::String(value.to_string());
    fs::write(&config_path, serde_json::to_string_pretty(&data)?)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "updated": true,
            "key": key,
            "value": value
        }))?;
        return Ok(());
    }

    println!("{} Set {} = {}", "OK".green(), key.cyan(), value);
    Ok(())
}

pub fn api_key_create(vault_path: &Path, format: OutputFormat) -> Result<()> {
    ensure_vault(vault_path)?;

    let key_bytes: [u8; 32] = rand::random();
    let api_key = format!("mzk_{}", hex::encode(&key_bytes[..16]));

    let mut hasher = Sha256::new();
    hasher.update(api_key.as_bytes());
    let hash = hex::encode(hasher.finalize());

    let key_config_path = vault_path.join(".mindzj").join("api_key_hash");
    fs::write(&key_config_path, &hash)?;

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({
            "created": true,
            "api_key": api_key
        }))?;
        return Ok(());
    }

    println!("{} API key created:", "OK".green());
    println!();
    println!("  {}", api_key.yellow().bold());
    println!();
    println!("{}", "Save this key - it will not be shown again.".dimmed());
    println!(
        "Set it as: {} or use {}",
        "export MINDZJ_API_KEY=<key>".cyan(),
        "--key <key>".cyan()
    );

    Ok(())
}

pub fn api_key_revoke(vault_path: &Path, format: OutputFormat) -> Result<()> {
    let key_path = vault_path.join(".mindzj").join("api_key_hash");
    let revoked = key_path.exists();

    if revoked {
        fs::remove_file(&key_path)?;
    }

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({ "revoked": revoked }))?;
        return Ok(());
    }

    if revoked {
        println!("{} API key revoked.", "OK".green());
    } else {
        println!("No API key configured.");
    }

    Ok(())
}

pub fn api_key_status(vault_path: &Path, format: OutputFormat) -> Result<()> {
    let key_path = vault_path.join(".mindzj").join("api_key_hash");
    let has_api_key = key_path.exists();

    if matches!(format, OutputFormat::Json) {
        emit_json(&json!({ "has_api_key": has_api_key }))?;
        return Ok(());
    }

    if has_api_key {
        println!("{} API key is configured.", "OK".green());
    } else {
        println!("{} No API key configured.", "ERR".red());
        println!("Create one with: {}", "mindzj config api-key create".cyan());
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn emit_json(value: &serde_json::Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn ensure_vault(vault_path: &Path) -> Result<()> {
    if !vault_path.join(".mindzj").exists() {
        eprintln!(
            "{} '{}' is not a MindZJ vault.",
            "Error:".red(),
            vault_path.display()
        );
        eprintln!(
            "Initialize with: {}",
            format!("mindzj vault open {}", vault_path.display()).cyan()
        );
        std::process::exit(1);
    }
    Ok(())
}

fn normalize_note_name(name: &str) -> String {
    if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{}.md", name)
    }
}

fn resolve_note_destination(vault_path: &Path, name: &str) -> PathBuf {
    let normalized = name.replace('\\', "/");
    let destination = normalize_note_name(&normalized);
    vault_path.join(destination)
}

fn read_content_input(content: Option<&str>, read_stdin: bool) -> Result<String> {
    if let Some(content) = content {
        return Ok(content.to_string());
    }
    if read_stdin {
        let mut buffer = String::new();
        io::stdin().read_to_string(&mut buffer)?;
        return Ok(buffer);
    }
    Ok(String::new())
}

fn read_required_content(content: Option<&str>, read_stdin: bool, action: &str) -> Result<String> {
    let value = read_content_input(content, read_stdin)?;
    if value.is_empty() {
        anyhow::bail!(
            "No content provided for {}. Use --content or --stdin.",
            action
        );
    }
    Ok(value)
}

fn atomic_write_string(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let tmp_path = path.with_extension("tmp");
    let mut tmp_file = fs::File::create(&tmp_path)?;
    tmp_file.write_all(content.as_bytes())?;
    tmp_file.sync_all()?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

fn create_delete_snapshot(vault_path: &Path, name: &str, file_path: &Path) -> Result<()> {
    let snapshots_dir = vault_path.join(".mindzj").join("snapshots");
    if !snapshots_dir.exists() {
        return Ok(());
    }

    let content = fs::read(file_path)?;
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let safe_name = name.replace('/', "__");
    let snapshot_path = snapshots_dir.join(format!("{}_{}_deleted", safe_name, timestamp));
    fs::write(snapshot_path, &content)?;
    Ok(())
}

fn try_resolve_note_path(vault_path: &Path, name: &str) -> Result<Option<PathBuf>> {
    let direct = vault_path.join(name);
    if direct.exists() {
        return Ok(Some(direct));
    }

    let with_ext = vault_path.join(format!("{}.md", name));
    if with_ext.exists() {
        return Ok(Some(with_ext));
    }

    let mut found = Vec::new();
    search_file_recursive(vault_path, name, &mut found)?;

    match found.len() {
        0 => Ok(None),
        1 => Ok(found.into_iter().next()),
        _ => {
            eprintln!("{} Multiple matches for '{}':", "Error:".red(), name);
            for path in &found {
                eprintln!("  {}", relative_display_path(vault_path, path));
            }
            eprintln!("Use the full path to specify which one.");
            std::process::exit(1);
        }
    }
}

fn resolve_note_path(vault_path: &Path, name: &str) -> Result<PathBuf> {
    match try_resolve_note_path(vault_path, name)? {
        Some(path) => Ok(path),
        None => {
            eprintln!("{} Note '{}' not found.", "Error:".red(), name);
            std::process::exit(1);
        }
    }
}

fn relative_display_path(vault_path: &Path, path: &Path) -> String {
    path.strip_prefix(vault_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn search_file_recursive(dir: &Path, name: &str, results: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if !path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            {
                search_file_recursive(&path, name, results)?;
            }
        } else {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy();
            let name_no_ext = file_name.trim_end_matches(".md");

            if file_name == name || name_no_ext == name {
                results.push(path);
            }
        }
    }
    Ok(())
}

fn collect_notes_recursive(
    dir: &Path,
    _vault_root: &Path,
    notes: &mut Vec<(PathBuf, String)>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if !path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            {
                collect_notes_recursive(&path, _vault_root, notes)?;
            }
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            let content = fs::read_to_string(&path).unwrap_or_default();
            notes.push((path, content));
        }
    }
    Ok(())
}

fn count_files_recursive(dir: &Path, md_count: &mut u32, total_size: &mut u64) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            if !path
                .file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
            {
                count_files_recursive(&path, md_count, total_size)?;
            }
        } else {
            let meta = entry.metadata()?;
            *total_size += meta.len();
            if path.extension().map(|e| e == "md").unwrap_or(false) {
                *md_count += 1;
            }
        }
    }
    Ok(())
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.2} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

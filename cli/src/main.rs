use anyhow::Result;
use clap::{Parser, Subcommand};
use colored::Colorize;
use std::path::PathBuf;

mod commands;

/// MindZJ CLI — AI-native, CLI-first note management
#[derive(Parser)]
#[command(
    name = "mindzj",
    version,
    about = "MindZJ: AI-native, CLI-first, open-source local note-taking system",
    long_about = None
)]
struct Cli {
    /// Path to the vault directory (defaults to current directory)
    #[arg(short, long, global = true)]
    vault: Option<PathBuf>,

    /// API key for authenticated operations
    #[arg(short = 'k', long, global = true)]
    key: Option<String>,

    /// Output format: text (default), json
    #[arg(short, long, global = true, default_value = "text")]
    format: OutputFormat,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum OutputFormat {
    Text,
    Json,
}

#[derive(Subcommand)]
enum Commands {
    /// Vault management
    Vault {
        #[command(subcommand)]
        action: VaultAction,
    },

    /// Note operations
    Note {
        #[command(subcommand)]
        action: NoteAction,
    },

    /// AI-powered features
    Ai {
        #[command(subcommand)]
        action: AiAction,
    },

    /// Configuration management
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Subcommand)]
enum VaultAction {
    /// Show information about the current vault
    Info,
    /// List all known vaults
    List,
    /// Open a vault (set as current working vault)
    Open {
        /// Path to the vault directory
        path: PathBuf,
    },
}

#[derive(Subcommand)]
enum NoteAction {
    /// Create a new note
    Create {
        /// Note name (without .md extension)
        name: String,
        /// Initial content (optional)
        #[arg(short, long)]
        content: Option<String>,
        /// Read note content from stdin
        #[arg(long)]
        stdin: bool,
        /// Create in a specific folder
        #[arg(short, long)]
        folder: Option<String>,
    },

    /// Overwrite a note with new content
    Write {
        /// Note name or path
        name: String,
        /// New content
        #[arg(short, long)]
        content: Option<String>,
        /// Read note content from stdin
        #[arg(long)]
        stdin: bool,
        /// Create the note if it does not exist
        #[arg(long)]
        create: bool,
    },

    /// Append content to the end of a note
    Append {
        /// Note name or path
        name: String,
        /// Content to append
        #[arg(short, long)]
        content: Option<String>,
        /// Read appended content from stdin
        #[arg(long)]
        stdin: bool,
    },

    /// Rename or move a note
    Move {
        /// Existing note name or path
        from: String,
        /// New note path
        to: String,
    },

    /// Read a note's content to stdout
    Read {
        /// Note name or path
        name: String,
    },

    /// List notes in the vault
    List {
        /// Filter by tag
        #[arg(short, long)]
        tag: Option<String>,
        /// Filter by directory
        #[arg(short, long)]
        dir: Option<String>,
    },

    /// Search notes by content
    Search {
        /// Search query
        query: String,
        /// Maximum results
        #[arg(short, long, default_value = "10")]
        limit: usize,
    },

    /// Delete a note
    Delete {
        /// Note name or path
        name: String,
        /// Skip confirmation prompt
        #[arg(short, long)]
        force: bool,
    },

    /// Show links for a note
    Links {
        /// Note name or path
        name: String,
    },
}

#[derive(Subcommand)]
enum AiAction {
    /// Ask a question based on your notes (RAG)
    Ask {
        /// Your question
        question: String,
    },

    /// Summarize a note
    Summarize {
        /// Note name or path
        name: String,
    },

    /// Auto-tag a note
    Tag {
        /// Note name or path
        name: String,
    },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Get a configuration value
    Get {
        /// Configuration key
        key: String,
    },

    /// Set a configuration value
    Set {
        /// Configuration key
        key: String,
        /// Configuration value
        value: String,
    },

    /// Manage API keys
    ApiKey {
        #[command(subcommand)]
        action: ApiKeyAction,
    },
}

#[derive(Subcommand)]
enum ApiKeyAction {
    /// Create a new API key
    Create,
    /// Revoke the current API key
    Revoke,
    /// Show API key status (not the key itself)
    Status,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let api_key = cli
        .key
        .clone()
        .or_else(|| std::env::var("MINDZJ_API_KEY").ok());

    // Resolve vault path
    let vault_path = cli.vault.unwrap_or_else(|| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });

    match cli.command {
        Commands::Vault { action } => match action {
            VaultAction::Info => commands::vault_info(&vault_path, cli.format),
            VaultAction::List => commands::vault_list(cli.format),
            VaultAction::Open { path } => commands::vault_open(&path, cli.format),
        },

        Commands::Note { action } => match action {
            NoteAction::Create {
                name,
                content,
                stdin,
                folder,
            } => commands::note_create(
                &vault_path,
                &name,
                content.as_deref(),
                stdin,
                folder.as_deref(),
                cli.format,
            ),

            NoteAction::Write {
                name,
                content,
                stdin,
                create,
            } => commands::note_write(
                &vault_path,
                &name,
                content.as_deref(),
                stdin,
                create,
                cli.format,
            ),

            NoteAction::Append {
                name,
                content,
                stdin,
            } => commands::note_append(
                &vault_path,
                &name,
                content.as_deref(),
                stdin,
                cli.format,
            ),

            NoteAction::Move { from, to } => {
                commands::note_move(&vault_path, &from, &to, cli.format)
            }

            NoteAction::Read { name } => commands::note_read(&vault_path, &name, cli.format),

            NoteAction::List { tag, dir } => {
                commands::note_list(&vault_path, tag.as_deref(), dir.as_deref(), cli.format)
            }

            NoteAction::Search { query, limit } => {
                commands::note_search(&vault_path, &query, limit, cli.format)
            }

            NoteAction::Delete { name, force } => {
                commands::note_delete(&vault_path, &name, force, cli.format)
            }

            NoteAction::Links { name } => commands::note_links(&vault_path, &name, cli.format),
        },

        Commands::Ai { action } => {
            // AI commands require API key validation
            if api_key.is_none() {
                eprintln!(
                    "{}",
                    "Error: AI commands require an API key.\n\
                     Set MINDZJ_API_KEY or use --key <key>."
                        .red()
                );
                std::process::exit(1);
            }

            match action {
                AiAction::Ask { question } => {
                    eprintln!(
                        "{}",
                        "AI features will be available in Phase 3.".yellow()
                    );
                    println!("Question: {}", question);
                    Ok(())
                }
                AiAction::Summarize { name } => {
                    eprintln!(
                        "{}",
                        "AI features will be available in Phase 3.".yellow()
                    );
                    println!("Summarize: {}", name);
                    Ok(())
                }
                AiAction::Tag { name } => {
                    eprintln!(
                        "{}",
                        "AI features will be available in Phase 3.".yellow()
                    );
                    println!("Auto-tag: {}", name);
                    Ok(())
                }
            }
        }

        Commands::Config { action } => match action {
            ConfigAction::Get { key } => commands::config_get(&vault_path, &key, cli.format),
            ConfigAction::Set { key, value } => {
                commands::config_set(&vault_path, &key, &value, cli.format)
            }
            ConfigAction::ApiKey { action: key_action } => match key_action {
                ApiKeyAction::Create => commands::api_key_create(&vault_path, cli.format),
                ApiKeyAction::Revoke => commands::api_key_revoke(&vault_path, cli.format),
                ApiKeyAction::Status => commands::api_key_status(&vault_path, cli.format),
            },
        },
    }
}

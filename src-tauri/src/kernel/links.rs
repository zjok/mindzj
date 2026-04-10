use crate::kernel::types::{GraphData, GraphEdge, GraphNode, LinkType, NoteLink};
use std::collections::HashMap;

/// Maintains a bidirectional link index for the entire vault.
///
/// When a markdown file is updated, `update_file_links` re-parses the
/// links in that file and updates both forward and backward indices.
/// The index is kept in memory for fast lookup and serialized to
/// `.mindzj/link-index.json` for persistence across sessions.
pub struct LinkIndex {
    /// Forward links: source file path -> list of links found in that file
    forward: HashMap<String, Vec<NoteLink>>,
    /// Backward links: target file path -> list of links pointing to it
    backward: HashMap<String, Vec<NoteLink>>,
    /// Set of all known file paths in the vault
    known_files: Vec<String>,
}

impl LinkIndex {
    pub fn new() -> Self {
        Self {
            forward: HashMap::new(),
            backward: HashMap::new(),
            known_files: Vec::new(),
        }
    }

    /// Register a known file in the vault (for resolving link targets).
    pub fn register_file(&mut self, path: &str) {
        if !self.known_files.contains(&path.to_string()) {
            self.known_files.push(path.to_string());
        }
    }

    /// Remove a file from the index entirely.
    pub fn remove_file(&mut self, path: &str) {
        self.forward.remove(path);
        self.known_files.retain(|p| p != path);

        // Remove all backlinks that pointed to this file
        for links in self.backward.values_mut() {
            links.retain(|l| l.source != path);
        }
        self.backward.remove(path);
    }

    /// Parse the content of a markdown file and update the link index.
    pub fn update_file_links(&mut self, source_path: &str, content: &str) {
        // Remove old forward links for this file
        if let Some(old_links) = self.forward.remove(source_path) {
            // Clean up backlinks from old state
            for link in &old_links {
                if let Some(backlinks) = self.backward.get_mut(&link.target) {
                    backlinks.retain(|l| l.source != source_path);
                }
            }
        }

        // Parse new links
        let links = Self::parse_links(source_path, content);

        // Update backward index
        for link in &links {
            self.backward
                .entry(link.target.clone())
                .or_insert_with(Vec::new)
                .push(link.clone());
        }

        // Store forward links
        self.forward.insert(source_path.to_string(), links);
    }

    /// Get all links originating from a file.
    pub fn get_forward_links(&self, source_path: &str) -> Vec<NoteLink> {
        self.forward.get(source_path).cloned().unwrap_or_default()
    }

    /// Get all links pointing to a file.
    pub fn get_backlinks(&self, target_path: &str) -> Vec<NoteLink> {
        self.backward.get(target_path).cloned().unwrap_or_default()
    }

    /// Get the backlink count for a specific file.
    pub fn backlink_count(&self, target_path: &str) -> u32 {
        self.backward
            .get(target_path)
            .map(|v| v.len() as u32)
            .unwrap_or(0)
    }

    /// Build graph data for the graph view.
    pub fn build_graph(&self) -> GraphData {
        let mut nodes: HashMap<String, GraphNode> = HashMap::new();
        let mut edges = Vec::new();

        // Create nodes for all known files
        for path in &self.known_files {
            let label = path
                .rsplit('/')
                .next()
                .unwrap_or(path)
                .trim_end_matches(".md")
                .to_string();

            nodes.insert(
                path.clone(),
                GraphNode {
                    id: path.clone(),
                    label,
                    path: path.clone(),
                    backlink_count: self.backlink_count(path),
                },
            );
        }

        // Create edges from forward links
        for (source, links) in &self.forward {
            for link in links {
                // Only create edges to known files
                if self.known_files.contains(&link.target) {
                    edges.push(GraphEdge {
                        source: source.clone(),
                        target: link.target.clone(),
                        link_type: link.link_type.clone(),
                    });
                }
            }
        }

        GraphData {
            nodes: nodes.into_values().collect(),
            edges,
        }
    }

    /// Get all unresolved links (links pointing to non-existent files).
    pub fn get_unresolved_links(&self) -> Vec<NoteLink> {
        let mut unresolved = Vec::new();

        for links in self.forward.values() {
            for link in links {
                if !self.known_files.contains(&link.target) {
                    unresolved.push(link.clone());
                }
            }
        }

        unresolved
    }

    // -----------------------------------------------------------------------
    // Link parsing
    // -----------------------------------------------------------------------

    /// Parse all links from markdown content.
    fn parse_links(source_path: &str, content: &str) -> Vec<NoteLink> {
        let mut links = Vec::new();
        let mut in_code_block = false;

        for (line_idx, line) in content.lines().enumerate() {
            let trimmed = line.trim();

            // Track code blocks to skip them
            if trimmed.starts_with("```") {
                in_code_block = !in_code_block;
                continue;
            }
            if in_code_block {
                continue;
            }

            // Parse wiki links: [[target]] or [[target|display]]
            Self::parse_wiki_links(source_path, line, line_idx as u32, &mut links);

            // Parse markdown links: [display](target.md)
            Self::parse_markdown_links(source_path, line, line_idx as u32, &mut links);

            // Parse embeds: ![[target]]
            Self::parse_embeds(source_path, line, line_idx as u32, &mut links);
        }

        links
    }

    /// Parse [[wikilinks]] from a line.
    fn parse_wiki_links(
        source: &str,
        line: &str,
        line_num: u32,
        links: &mut Vec<NoteLink>,
    ) {
        let bytes = line.as_bytes();
        let len = bytes.len();
        let mut i = 0;

        while i + 1 < len {
            // Look for [[ but not ![[
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if i > 0 && bytes[i - 1] == b'!' {
                    i += 2;
                    continue; // This is an embed, handled separately
                }

                let start = i + 2;
                // Find closing ]]
                if let Some(end_pos) = line[start..].find("]]") {
                    let inner = &line[start..start + end_pos];

                    // Split on | for display text
                    let (target, display) = if let Some(pipe_pos) = inner.find('|') {
                        (
                            inner[..pipe_pos].trim(),
                            Some(inner[pipe_pos + 1..].trim().to_string()),
                        )
                    } else {
                        (inner.trim(), None)
                    };

                    if !target.is_empty() {
                        let target_path = Self::resolve_link_target(target);
                        links.push(NoteLink {
                            source: source.to_string(),
                            target: target_path,
                            display_text: display,
                            link_type: LinkType::WikiLink,
                            line: line_num,
                            column: i as u32,
                        });
                    }

                    i = start + end_pos + 2;
                } else {
                    i += 2;
                }
            } else {
                i += 1;
            }
        }
    }

    /// Parse [text](url) markdown links from a line.
    fn parse_markdown_links(
        source: &str,
        line: &str,
        line_num: u32,
        links: &mut Vec<NoteLink>,
    ) {
        let bytes = line.as_bytes();
        let len = bytes.len();
        let mut i = 0;

        while i < len {
            // Look for [ but not ![ and not [[
            if bytes[i] == b'['
                && !(i > 0 && bytes[i - 1] == b'!')
                && !(i + 1 < len && bytes[i + 1] == b'[')
            {
                let display_start = i + 1;
                if let Some(close_bracket) = line[display_start..].find(']') {
                    let display_end = display_start + close_bracket;
                    let display_text = &line[display_start..display_end];

                    // Check for (url) immediately after ]
                    let after_bracket = display_end + 1;
                    if after_bracket < len && bytes[after_bracket] == b'(' {
                        let url_start = after_bracket + 1;
                        if let Some(close_paren) = line[url_start..].find(')') {
                            let url = line[url_start..url_start + close_paren].trim();

                            // Only track internal links (not http/https)
                            if !url.starts_with("http://")
                                && !url.starts_with("https://")
                                && !url.starts_with("mailto:")
                                && !url.is_empty()
                            {
                                let target_path = Self::resolve_link_target(url);
                                links.push(NoteLink {
                                    source: source.to_string(),
                                    target: target_path,
                                    display_text: if display_text.is_empty() {
                                        None
                                    } else {
                                        Some(display_text.to_string())
                                    },
                                    link_type: LinkType::MarkdownLink,
                                    line: line_num,
                                    column: i as u32,
                                });
                            }

                            i = url_start + close_paren + 1;
                            continue;
                        }
                    }
                    i = display_end + 1;
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
    }

    /// Parse ![[embeds]] from a line.
    fn parse_embeds(
        source: &str,
        line: &str,
        line_num: u32,
        links: &mut Vec<NoteLink>,
    ) {
        let bytes = line.as_bytes();
        let len = bytes.len();
        let mut i = 0;

        while i + 2 < len {
            if bytes[i] == b'!' && bytes[i + 1] == b'[' && bytes[i + 2] == b'[' {
                let start = i + 3;
                if let Some(end_pos) = line[start..].find("]]") {
                    let target = line[start..start + end_pos].trim();

                    if !target.is_empty() {
                        let target_path = Self::resolve_link_target(target);
                        links.push(NoteLink {
                            source: source.to_string(),
                            target: target_path,
                            display_text: None,
                            link_type: LinkType::Embed,
                            line: line_num,
                            column: i as u32,
                        });
                    }

                    i = start + end_pos + 2;
                } else {
                    i += 3;
                }
            } else {
                i += 1;
            }
        }
    }

    /// Resolve a link target string to a vault-relative file path.
    /// Handles: "note", "note.md", "folder/note", "folder/note.md"
    fn resolve_link_target(target: &str) -> String {
        let target = target.trim();

        // Strip any heading anchor (e.g., "note#heading")
        let target = target.split('#').next().unwrap_or(target);

        // Add .md extension if not present and no other extension
        if !target.contains('.') {
            format!("{}.md", target)
        } else {
            target.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_wiki_links() {
        let content = "Here is a [[note]] and [[folder/other|Other Note]].";
        let links = LinkIndex::parse_links("source.md", content);

        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "note.md");
        assert_eq!(links[0].link_type, LinkType::WikiLink);
        assert_eq!(links[1].target, "folder/other.md");
        assert_eq!(links[1].display_text, Some("Other Note".to_string()));
    }

    #[test]
    fn test_parse_markdown_links() {
        let content = "A [link](note.md) and [another](folder/file.md).";
        let links = LinkIndex::parse_links("source.md", content);

        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "note.md");
        assert_eq!(links[0].link_type, LinkType::MarkdownLink);
    }

    #[test]
    fn test_skip_external_links() {
        let content = "[Google](https://google.com) and [[internal]]";
        let links = LinkIndex::parse_links("source.md", content);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "internal.md");
    }

    #[test]
    fn test_parse_embeds() {
        let content = "Embed: ![[image.png]] and ![[note]]";
        let links = LinkIndex::parse_links("source.md", content);

        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "image.png");
        assert_eq!(links[0].link_type, LinkType::Embed);
    }

    #[test]
    fn test_skip_code_blocks() {
        let content = "```\n[[not a link]]\n```\n\n[[real link]]";
        let links = LinkIndex::parse_links("source.md", content);

        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "real link.md");
    }

    #[test]
    fn test_backlinks() {
        let mut index = LinkIndex::new();
        index.register_file("a.md");
        index.register_file("b.md");

        index.update_file_links("a.md", "Link to [[b]]");

        let backlinks = index.get_backlinks("b.md");
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source, "a.md");
    }

    #[test]
    fn test_graph_data() {
        let mut index = LinkIndex::new();
        index.register_file("a.md");
        index.register_file("b.md");
        index.register_file("c.md");

        index.update_file_links("a.md", "Links to [[b]] and [[c]]");
        index.update_file_links("b.md", "Links back to [[a]]");

        let graph = index.build_graph();
        assert_eq!(graph.nodes.len(), 3);
        assert_eq!(graph.edges.len(), 3);
    }
}

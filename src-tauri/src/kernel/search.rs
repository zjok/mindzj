use crate::kernel::error::KernelResult;
use crate::kernel::types::{SearchQuery, SearchResult, SearchSnippet};
use std::collections::HashMap;
use tracing::info;

/// Full-text search index for vault content.
///
/// Phase 1 uses a simple in-memory inverted index.
/// Phase 3 will migrate to tantivy for production-grade search.
pub struct SearchIndex {
    /// file_path -> file content (for snippet extraction)
    documents: HashMap<String, String>,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            documents: HashMap::new(),
        }
    }

    /// Add or update a document in the index.
    pub fn index_document(&mut self, path: &str, content: &str) {
        self.documents.insert(path.to_string(), content.to_string());
    }

    /// Remove a document from the index.
    pub fn remove_document(&mut self, path: &str) {
        self.documents.remove(path);
    }

    /// Search for documents matching the query.
    pub fn search(&self, query: &SearchQuery) -> KernelResult<Vec<SearchResult>> {
        let search_text = query.text.to_lowercase();

        if search_text.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();

        for (path, content) in &self.documents {
            // Apply filters
            if let Some(ref ext_filter) = query.extension_filter {
                if !path.ends_with(ext_filter) {
                    continue;
                }
            }
            if let Some(ref path_filter) = query.path_filter {
                if !path.starts_with(path_filter) {
                    continue;
                }
            }

            let content_lower = content.to_lowercase();

            // Find all occurrences
            let mut snippets = Vec::new();
            let mut search_from = 0;

            while let Some(pos) = content_lower[search_from..].find(&search_text) {
                let absolute_pos = search_from + pos;

                // Calculate line number
                let line = content[..absolute_pos]
                    .chars()
                    .filter(|c| *c == '\n')
                    .count() as u32;

                // Extract snippet with context (up to 80 chars before and after)
                let snippet_start = content[..absolute_pos]
                    .rfind('\n')
                    .map(|p| p + 1)
                    .unwrap_or(0);

                let snippet_end = content[absolute_pos..]
                    .find('\n')
                    .map(|p| absolute_pos + p)
                    .unwrap_or(content.len());

                let snippet_text = content[snippet_start..snippet_end].to_string();
                let highlight_start = (absolute_pos - snippet_start) as u32;
                let highlight_end = highlight_start + search_text.len() as u32;

                snippets.push(SearchSnippet {
                    text: snippet_text,
                    line,
                    highlight_start,
                    highlight_end,
                });

                search_from = absolute_pos + search_text.len();

                // Limit snippets per file
                if snippets.len() >= 5 {
                    break;
                }
            }

            if !snippets.is_empty() {
                // Simple scoring: more matches = higher score, title matches boost score
                let match_count = snippets.len() as f32;
                let file_name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
                let title_boost = if file_name.contains(&search_text) {
                    2.0
                } else {
                    0.0
                };
                let score = (match_count + title_boost)
                    / (1.0 + content.len() as f32 / 1000.0);

                results.push(SearchResult {
                    path: path.clone(),
                    file_name: path.rsplit('/').next().unwrap_or(path).to_string(),
                    snippets,
                    score: score.min(1.0),
                });
            }
        }

        // Sort by score descending
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Apply limit
        results.truncate(query.limit);

        info!(
            "Search '{}' returned {} results",
            query.text,
            results.len()
        );

        Ok(results)
    }

    /// Get the total number of indexed documents.
    pub fn document_count(&self) -> usize {
        self.documents.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_query(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.to_string(),
            limit: 10,
            extension_filter: None,
            path_filter: None,
        }
    }

    #[test]
    fn test_basic_search() {
        let mut index = SearchIndex::new();
        index.index_document("note1.md", "Hello world, this is a test");
        index.index_document("note2.md", "Another document without the match");
        index.index_document("note3.md", "Hello again, hello friends");

        let results = index.search(&make_query("hello")).unwrap();
        assert_eq!(results.len(), 2);
        // note3 should score higher (more matches)
        assert_eq!(results[0].path, "note3.md");
    }

    #[test]
    fn test_case_insensitive() {
        let mut index = SearchIndex::new();
        index.index_document("note.md", "Hello WORLD");

        let results = index.search(&make_query("hello world")).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_extension_filter() {
        let mut index = SearchIndex::new();
        index.index_document("note.md", "test content");
        index.index_document("data.json", "test content");

        let query = SearchQuery {
            text: "test".to_string(),
            limit: 10,
            extension_filter: Some(".md".to_string()),
            path_filter: None,
        };

        let results = index.search(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "note.md");
    }

    #[test]
    fn test_snippet_highlighting() {
        let mut index = SearchIndex::new();
        index.index_document("note.md", "Line one\nLine with match here\nLine three");

        let results = index.search(&make_query("match")).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].snippets[0].line, 1);
        assert!(results[0].snippets[0].highlight_start > 0);
    }

    #[test]
    fn test_empty_query() {
        let mut index = SearchIndex::new();
        index.index_document("note.md", "content");

        let results = index.search(&make_query("")).unwrap();
        assert!(results.is_empty());
    }
}

/**
 * URL auto-linking utilities.
 *
 * Detects bare URLs in text (with or without scheme) so they can be
 * rendered as clickable links in reading + live-preview mode. The
 * regex is deliberately conservative — it requires either an explicit
 * `http://` / `https://` scheme, OR a `www.` prefix, OR a domain that
 * ends in a TLD from a finite allow-list. That prevents accidental
 * matches on things that LOOK domain-ish but aren't — "v1.2.3",
 * "file.md", "node.js", etc. — which would be hugely noisy.
 *
 * Trailing punctuation (`.`, `,`, `:`, `;`, `!`, `?`, closing
 * brackets) is stripped from the match so we don't link characters
 * that clearly belong to the surrounding sentence.
 */

// Common TLDs users paste as bare domains. Not exhaustive — the goal
// is to catch the 95% case (github.com, google.com, …) while
// rejecting filename-like patterns. Users who need a niche TLD can
// always use the explicit `https://` form, which matches regardless.
const TLDS = [
    "com", "org", "net", "edu", "gov", "mil", "int",
    "io", "ai", "app", "dev", "co", "me", "info", "biz",
    "cn", "uk", "us", "de", "fr", "jp", "au", "ca", "ru", "in", "br",
    "tech", "site", "store", "blog", "cloud", "online", "shop", "page",
    "cc", "tv", "xyz", "pro", "name", "asia", "mobi",
].join("|");

// Compiled once per module load. The alternations cover:
//   1. `https?://…` with any non-space-ish characters
//   2. `www.domain.TLD/…` (scheme optional, www implied)
//   3. bare `domain.TLD(/…)?` with a TLD from the allow-list
export const URL_REGEX = new RegExp(
    [
        "\\bhttps?:\\/\\/[^\\s<>\"')\\]{}]+",
        `\\bwww\\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\\.(?:${TLDS})(?=$|[^a-zA-Z0-9-]|\\/)(?:\\/[^\\s<>\"')\\]{}]*)?`,
        `\\b(?:[a-zA-Z][a-zA-Z0-9-]*\\.)+(?:${TLDS})(?=$|[^a-zA-Z0-9-]|\\/)(?:\\/[^\\s<>"')\\]{}]*)?`,
    ].join("|"),
    "g",
);

/**
 * Strip trailing punctuation that probably belongs to the sentence,
 * not the URL. Runs repeatedly so "https://x.com!!!" → "https://x.com".
 */
export function trimTrailingPunct(url: string): string {
    while (url.length > 0 && /[.,:;!?)\]'"]$/.test(url)) {
        url = url.slice(0, -1);
    }
    return url;
}

/**
 * Normalise a bare URL to an openable `https://…` form. `github.com/x`
 * needs a scheme before `shell.open` will treat it as an external
 * URL; `www.…` also gets an `https://` prefix so it opens in the
 * default browser rather than being interpreted as a relative path.
 */
export function ensureScheme(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${url}`;
}

/**
 * Walk a string finding every URL match. Yields `{index, match}` with
 * trailing punctuation already trimmed. Callers can iterate to build
 * decorations or HTML replacements.
 */
export function* findUrlMatches(text: string): Generator<{ index: number; match: string }> {
    URL_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_REGEX.exec(text)) !== null) {
        const trimmed = trimTrailingPunct(m[0]);
        if (!trimmed) continue;
        yield { index: m.index, match: trimmed };
    }
}

/**
 * Linkify bare URLs inside an HTML string WITHOUT touching URLs that
 * are already part of an existing `<a>` tag or other element. Splits
 * the input by `<…>` tag boundaries, processes only the text
 * between tags, and re-joins. This avoids double-wrapping markdown
 * links (`[text](url)` → already an `<a>` by the time we see it) and
 * prevents corrupting attribute values like `href="…"`.
 *
 * The replacer callback receives the raw URL and should return the
 * replacement HTML. Callers decide escaping (reading mode uses
 * `escapeAttr`, etc.).
 */
export function linkifyHtmlText(
    html: string,
    replace: (url: string) => string,
): string {
    // Split on tag boundaries. Even indices are text, odd indices
    // are tags (or tag-like fragments). Tags pass through verbatim.
    const parts = html.split(/(<[^>]*>)/g);
    let anchorDepth = 0;
    for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            const tag = parts[i].trim().toLowerCase();
            if (/^<a(?:\s|>)/.test(tag) && !/\/>$/.test(tag)) {
                anchorDepth += 1;
            } else if (/^<\/a\s*>/.test(tag)) {
                anchorDepth = Math.max(0, anchorDepth - 1);
            }
            continue;
        }

        if (anchorDepth > 0) continue;
        const segment = parts[i];
        if (!segment) continue;
        parts[i] = segment.replace(URL_REGEX, (match) => {
            const trimmed = trimTrailingPunct(match);
            if (!trimmed) return match;
            const trailing = match.slice(trimmed.length);
            return replace(trimmed) + trailing;
        });
    }
    return parts.join("");
}

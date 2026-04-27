/**
 * Image size helpers — parse and serialize the width/height suffix
 * that uses in image alt text to persist per-image display
 * sizes.
 *
 * Convention (matches / Markdown extensions):
 *
 *     ![alt text|400](path/to/img.png)       → width 400, height auto
 *     ![alt text|400x300](path/to/img.png)   → width 400, height 300
 *     ![|400](path/to/img.png)                → empty alt, width 400
 *     ![alt text](path/to/img.png)            → no size, natural width
 *
 * The pipe delimiter `|` lives INSIDE the alt-text brackets. This
 * works with standard CommonMark parsers (the bracket contents are
 * opaque text to them), and keeps the markdown portable — other
 * editors render the same sizes.
 *
 * Both `Editor.tsx` (live preview) and `ReadingView.tsx` parse the
 * alt with `parseImageSize` on render, apply `width:<px>px; height:
 * ...` to the `<img>` element, and leave the raw markdown untouched.
 * When the user alt+wheel-zooms an image, the wheel handler calls
 * `formatImageAlt` to build the new alt string and dispatches a
 * source edit that rewrites the markdown in place.
 */

export interface ImageSizeSpec {
    /** Alt text with the `|size` suffix stripped. */
    altText: string;
    /** Parsed width in pixels, or null if not specified. */
    width: number | null;
    /** Parsed height in pixels, or null if not specified. */
    height: number | null;
}

/**
 * Parse an image alt-text string that may contain a trailing
 * `|width` or `|widthxheight` size suffix.
 *
 * Examples:
 *   parseImageSize("cat photo|400")    → { altText: "cat photo", width: 400, height: null }
 *   parseImageSize("cat photo|400x300") → { altText: "cat photo", width: 400, height: 300 }
 *   parseImageSize("cat photo")         → { altText: "cat photo", width: null, height: null }
 *   parseImageSize("|400")              → { altText: "", width: 400, height: null }
 */
export function parseImageSize(alt: string): ImageSizeSpec {
    // Regex anchored to end: any number of chars (non-greedy), then
    // `|`, then a positive integer, then optionally `x<integer>`.
    const m = alt.match(/^(.*?)\|(\d+)(?:x(\d+))?$/);
    if (!m) {
        return { altText: alt, width: null, height: null };
    }
    const width = parseInt(m[2], 10);
    const height = m[3] ? parseInt(m[3], 10) : null;
    if (!Number.isFinite(width) || width <= 0) {
        return { altText: alt, width: null, height: null };
    }
    return {
        altText: m[1],
        width,
        height: height != null && Number.isFinite(height) && height > 0 ? height : null,
    };
}

/**
 * Build an alt-text string that encodes the given size.
 *
 * Examples:
 *   formatImageAlt("cat photo", 400, null) → "cat photo|400"
 *   formatImageAlt("cat photo", 400, 300)  → "cat photo|400x300"
 *   formatImageAlt("cat photo", null, null) → "cat photo"
 *   formatImageAlt("", 400, null)          → "|400"
 */
export function formatImageAlt(
    altText: string,
    width: number | null,
    height: number | null,
): string {
    if (width == null) return altText;
    if (height != null) return `${altText}|${width}x${height}`;
    return `${altText}|${width}`;
}

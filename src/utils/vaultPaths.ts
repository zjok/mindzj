import { convertFileSrc } from "@tauri-apps/api/core";

export const DEFAULT_ATTACHMENT_FOLDER = ".mindzj/images";

// Matches URL schemes (http:, https:, ftp:, etc.) but NOT single-letter
// Windows drive designations (C:, D:) — the `+` requires at least two
// characters before the colon so a bare drive letter doesn't match.
const EXTERNAL_PATH_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

export function normalizeVaultRelativePath(
  path: string,
  fallback = DEFAULT_ATTACHMENT_FOLDER,
): string {
  const normalized = normalizeSlashes(path).trim().replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return trimmed || fallback;
}

export function getParentPath(path: string): string {
  const normalized = normalizeSlashes(path).replace(/\/+$/g, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : "";
}

export function joinVaultPath(...parts: string[]): string {
  const segments: string[] = [];

  for (const part of parts) {
    const normalized = normalizeSlashes(part).split("/");
    for (const segment of normalized) {
      if (!segment || segment === ".") continue;
      if (segment === "..") {
        if (segments.length > 0) segments.pop();
        continue;
      }
      segments.push(segment);
    }
  }

  return segments.join("/");
}

export function isExternalPath(path: string): boolean {
  return EXTERNAL_PATH_RE.test(path) || path.startsWith("data:");
}

export function resolveNoteRelativePath(
  path: string,
  currentFilePath?: string,
): string {
  const normalized = normalizeSlashes(path).trim();
  if (!normalized) return "";
  if (normalized.startsWith("/")) {
    return joinVaultPath(normalized.slice(1));
  }
  if (normalized.startsWith(".mindzj/")) {
    return joinVaultPath(normalized);
  }
  return joinVaultPath(getParentPath(currentFilePath ?? ""), normalized);
}

export function toVaultAssetUrl(vaultRoot: string, relativePath: string): string {
  let root = normalizeSlashes(vaultRoot).replace(/\/+$/g, "");
  // Strip Windows extended-length path prefix added by Rust's
  // fs::canonicalize().  \\?\ becomes //?/ after normalizeSlashes.
  // The ? in the URL would be interpreted as a query-string delimiter,
  // making the asset protocol unable to resolve the file path.
  root = root.replace(/^\/\/\?\//, "");
  const rel = normalizeVaultRelativePath(relativePath, "");
  const absolutePath = rel ? `${root}/${rel}` : root;
  return convertFileSrc(absolutePath);
}

export function resolveImageAssetUrl(
  src: string,
  vaultRoot: string,
  currentFilePath?: string,
): string {
  if (isExternalPath(src)) return src;
  return toVaultAssetUrl(vaultRoot, resolveNoteRelativePath(src, currentFilePath));
}

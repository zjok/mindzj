export interface MarkerColor {
    id: string;
    label: string;
    color: string;
}

export const DEFAULT_MARKER_COLORS: MarkerColor[] = [
    { id: "yellow", label: "Yellow", color: "#facc15" },
    { id: "pink", label: "Pink", color: "#fb7185" },
    { id: "orange", label: "Orange", color: "#fb923c" },
    { id: "green", label: "Green", color: "#4ade80" },
    { id: "blue", label: "Blue", color: "#60a5fa" },
    { id: "purple", label: "Purple", color: "#a78bfa" },
    { id: "gray", label: "Gray", color: "#94a3b8" },
];

export const DEFAULT_MARKER_COLOR_VALUES = DEFAULT_MARKER_COLORS.map(
    (item) => item.color,
);

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function normalizeMarkerColor(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return HEX_COLOR_RE.test(normalized) ? normalized : null;
}

export function normalizeMarkerPalette(value: unknown): string[] {
    const source = Array.isArray(value) ? value : [];
    return DEFAULT_MARKER_COLORS.map((fallback, index) => {
        const color = normalizeMarkerColor(source[index]);
        return color ?? fallback.color;
    });
}

export function getMarkerPalette(value: unknown): MarkerColor[] {
    const colors = normalizeMarkerPalette(value);
    return DEFAULT_MARKER_COLORS.map((item, index) => ({
        ...item,
        color: colors[index],
    }));
}

export function resolveMarkerColor(
    value: unknown,
    paletteValue?: unknown,
): string | null {
    const hex = normalizeMarkerColor(value);
    if (hex) return hex;
    if (typeof value !== "string") return null;

    const normalized = value.trim().toLowerCase();
    const index = DEFAULT_MARKER_COLORS.findIndex(
        (item) => item.id === normalized,
    );
    if (index < 0) return null;

    return normalizeMarkerPalette(paletteValue)[index];
}

export function getReadableMarkerTextColor(color: string): string {
    const normalized = normalizeMarkerColor(color);
    if (!normalized) return "var(--mz-text-primary)";

    const red = Number.parseInt(normalized.slice(1, 3), 16);
    const green = Number.parseInt(normalized.slice(3, 5), 16);
    const blue = Number.parseInt(normalized.slice(5, 7), 16);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

    return luminance > 0.55 ? "#111827" : "#f9fafb";
}

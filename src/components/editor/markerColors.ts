export interface MarkerColor {
    id: string;
    label: string;
    color: string;
}

export const DEFAULT_MARKER_COLORS: MarkerColor[] = [
    { id: "yellow", label: "Yellow", color: "#fde047" },
    { id: "pink", label: "Pink", color: "#f9a8d4" },
    { id: "orange", label: "Orange", color: "#fdba74" },
    { id: "green", label: "Green", color: "#86efac" },
    { id: "blue", label: "Blue", color: "#93c5fd" },
    { id: "purple", label: "Purple", color: "#c4b5fd" },
    { id: "gray", label: "Gray", color: "#d1d5db" },
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

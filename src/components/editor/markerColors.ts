export interface MarkerColor {
    id: string;
    label: string;
    color: string;
}

export const MARKER_COLORS: MarkerColor[] = [
    { id: "yellow", label: "Yellow", color: "#fde047" },
    { id: "pink", label: "Pink", color: "#f9a8d4" },
    { id: "orange", label: "Orange", color: "#fdba74" },
    { id: "green", label: "Green", color: "#86efac" },
    { id: "blue", label: "Blue", color: "#93c5fd" },
];

export const MARKER_COLOR_ID_PATTERN = MARKER_COLORS.map((item) => item.id).join("|");

export function getMarkerColor(id: unknown): MarkerColor | null {
    if (typeof id !== "string") return null;
    const normalized = id.toLowerCase();
    return MARKER_COLORS.find((item) => item.id === normalized) ?? null;
}

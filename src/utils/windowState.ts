const MIN_PERSISTED_WINDOW_WIDTH = 320;
const MIN_PERSISTED_WINDOW_HEIGHT = 240;
const MAX_REASONABLE_WINDOW_COORD = 10000;

export type PersistableWindowState = {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
};

export function createPersistableWindowState(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
}): PersistableWindowState | null {
    const x = Math.round(bounds.x);
    const y = Math.round(bounds.y);
    const width = Math.round(bounds.width);
    const height = Math.round(bounds.height);

    if (Math.abs(x) > MAX_REASONABLE_WINDOW_COORD || Math.abs(y) > MAX_REASONABLE_WINDOW_COORD) {
        return null;
    }
    if (width < MIN_PERSISTED_WINDOW_WIDTH || height < MIN_PERSISTED_WINDOW_HEIGHT) {
        return null;
    }

    return { x, y, width, height, maximized: false };
}

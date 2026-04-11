/**
 * Image interaction utilities for MindZJ
 *
 * Provides:
 * - Alt+mousewheel zoom on images (configurable modifier key)
 * - Ctrl+click behavior (open in new tab / default app / explorer)
 * - Resize presets for the right-click context menu
 *
 * Works in both LivePreview and ReadingView.
 *
 * SCROLL BUG FIX: The wheel handler is attached directly to each <img>
 * element (NOT the scroll container). This ensures that Chrome's scroll
 * compositor optimization is only disabled for events whose target is an
 * image — all other wheel events go through the fast compositor path.
 *
 * Additionally:
 * - We NEVER call stopPropagation() — CodeMirror always sees the event
 *   and can update its internal scroll-position bookkeeping.
 * - DOM changes (image width) are batched via requestAnimationFrame so
 *   a rapid stream of wheel events doesn't overwhelm CM6's layout.
 */

import { invoke } from "@tauri-apps/api/core";
import { settingsStore } from "../stores/settings";
import { openFileRouted } from "./openFileRouted";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the comma-separated resize options string into an array of labels */
export function parseResizeOptions(optStr: string): string[] {
  return optStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Check if the modifier key for the given event matches the configured key */
function isModifierPressed(e: WheelEvent | MouseEvent, key: string): boolean {
  switch (key) {
    case "Alt":
      return e.altKey;
    case "Ctrl":
      return e.ctrlKey || e.metaKey;
    case "Shift":
      return e.shiftKey;
    default:
      return e.altKey;
  }
}

/**
 * Get the natural (intrinsic) width of an image. Falls back to rendered
 * width if naturalWidth is unavailable (e.g. image not yet fully loaded).
 */
function getNaturalWidth(img: HTMLImageElement): number {
  return img.naturalWidth || img.offsetWidth || 400;
}

/** Resolve image vault-relative path from raw markdown src */
function resolveImagePath(
  imageSrc: string,
  currentFilePath: string,
): string {
  let imgPath = imageSrc;
  if (imgPath.startsWith("./") || imgPath.startsWith("../")) {
    const dir = currentFilePath.includes("/")
      ? currentFilePath.split("/").slice(0, -1).join("/")
      : "";
    const parts = (dir ? dir + "/" + imgPath : imgPath).split("/");
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === "..") resolved.pop();
      else if (p !== ".") resolved.push(p);
    }
    imgPath = resolved.join("/");
  }
  if (imgPath.startsWith("/")) imgPath = imgPath.slice(1);
  return imgPath;
}

// ---------------------------------------------------------------------------
// Mousewheel zoom — per-image listener with RAF throttle
// ---------------------------------------------------------------------------

/**
 * Attach a wheel listener to an individual <img> element.
 *
 * Key design decisions that fix the scroll bug:
 *
 *  1. The listener lives on the <img>, NOT on the scroll container.
 *     Chrome's compositor can therefore fast-path all wheel events
 *     that don't target an image — normal scrolling stays buttery
 *     smooth regardless of how many images are on the page.
 *
 *  2. We never call `stopPropagation()`. CodeMirror's own scroll
 *     handler still sees the event. Since `defaultPrevented` is true,
 *     CM6 doesn't actually scroll but it DOES update its internal
 *     scroll-position tracking — preventing the "stale viewport"
 *     de-sync that caused subsequent scrolling to glitch.
 *
 *  3. DOM mutations (img.style.width) are batched via rAF so that a
 *     fast scroll wheel doesn't force synchronous layout on every
 *     single wheel tick.
 *
 * Returns a cleanup function to remove the listener.
 */
export function attachWheelZoom(img: HTMLImageElement): (() => void) | null {
  const s = settingsStore.settings();
  if (!s.image_wheel_zoom) return null;

  let rafId = 0;
  let pendingDelta = 0;

  function handler(e: WheelEvent) {
    const settings = settingsStore.settings();
    if (!settings.image_wheel_zoom) return;
    if (!isModifierPressed(e, settings.image_wheel_modifier)) return;

    // Prevent the scroll — but do NOT stopPropagation.
    e.preventDefault();

    // Accumulate delta and batch the DOM write into one rAF frame.
    pendingDelta += e.deltaY;
    if (rafId) return; // already scheduled

    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const delta = pendingDelta;
      pendingDelta = 0;

      const step = settings.image_wheel_zoom_step / 100;
      const invert = settings.image_wheel_invert;
      const direction = invert
        ? (delta > 0 ? 1 : -1)
        : (delta > 0 ? -1 : 1);

      const currentWidth =
        img.style.width && img.style.width.endsWith("px")
          ? parseFloat(img.style.width)
          : img.offsetWidth || getNaturalWidth(img);

      const newWidth = Math.max(
        20,
        Math.round(currentWidth * (1 + direction * step)),
      );
      img.style.width = newWidth + "px";
      img.style.height = "auto";
      img.setAttribute("data-ppi-wheel-inline-width", String(newWidth));
    });
  }

  img.addEventListener("wheel", handler, { passive: false });

  return () => {
    img.removeEventListener("wheel", handler);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

// ---------------------------------------------------------------------------
// Ctrl + click behavior
// ---------------------------------------------------------------------------

/**
 * Attach a click listener that handles Ctrl+click on the image
 * according to user settings.
 *
 * Returns a cleanup function.
 */
export function attachCtrlClick(
  img: HTMLImageElement,
  imageSrc: string,
  currentFilePath: string,
): (() => void) | null {
  function handler(e: MouseEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();

    const settings = settingsStore.settings();
    const imgPath = resolveImagePath(imageSrc, currentFilePath);

    switch (settings.image_ctrl_click) {
      case "open-in-default-app":
        invoke("open_in_default_app", { relativePath: imgPath }).catch(
          (err) => console.warn("[ImageCtrlClick] open_in_default_app:", err),
        );
        break;
      case "show-in-explorer":
        invoke("reveal_in_file_manager", { relativePath: imgPath }).catch(
          (err) => console.warn("[ImageCtrlClick] reveal_in_file_manager:", err),
        );
        break;
      case "open-in-new-tab":
      default:
        void openFileRouted(imgPath);
        break;
    }
  }

  img.addEventListener("click", handler);
  return () => img.removeEventListener("click", handler);
}

// ---------------------------------------------------------------------------
// Resize presets — context menu integration
// ---------------------------------------------------------------------------

/**
 * Apply a resize preset to an image element.
 * Supports:
 * - Percentage values like "50%" — relative to natural width
 * - Pixel values like "600px" — absolute pixel width
 */
export function applyResizePreset(img: HTMLImageElement, preset: string) {
  const trimmed = preset.trim();
  let newWidth: number;

  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed) / 100;
    newWidth = Math.round(getNaturalWidth(img) * pct);
  } else if (trimmed.endsWith("px")) {
    newWidth = parseInt(trimmed);
  } else {
    newWidth = parseInt(trimmed);
    if (isNaN(newWidth)) return;
  }

  if (isNaN(newWidth) || newWidth < 10) return;

  img.style.width = newWidth + "px";
  img.style.height = "auto";
  img.setAttribute("data-ppi-wheel-inline-width", String(newWidth));
}

/**
 * Build an array of resize preset menu item configs to be added
 * to the image context menu.
 */
export function getResizePresets(): string[] {
  const s = settingsStore.settings();
  return parseResizeOptions(s.image_resize_options);
}

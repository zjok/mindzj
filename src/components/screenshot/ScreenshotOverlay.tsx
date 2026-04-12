/**
 * Screenshot Overlay — QQ-style screenshot tool for MindZJ
 *
 * Features:
 * 1. Full-screen overlay shows the captured screenshot
 * 2. User drags to select a region (crop area)
 * 3. Selection can be moved by dragging inside it
 * 4. Annotation toolbar: rect, circle, arrow, line, text, freehand, mosaic
 * 5. Annotations can be selected and moved after drawing
 * 6. Confirm: saves to vault & inserts into current note
 */

import { Component, createSignal, Show, onMount, onCleanup } from "solid-js";
import { t } from "../../i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Rect { x: number; y: number; w: number; h: number; }

type ToolType = "select" | "rect" | "circle" | "arrow" | "line" | "text" | "freehand" | "mosaic";

interface Annotation {
  id: number;
  tool: ToolType;
  color: string;
  lineWidth: number;
  /** For shapes: [start, end]; for freehand: all points */
  points: { x: number; y: number }[];
  text?: string;
  fontSize?: number;
  /** Bounding box for hit-testing / move */
  bounds?: Rect;
}

interface ScreenshotOverlayProps {
  screenshotBase64: string;
  onClose: () => void;
  onSave: (base64Png: string) => void;
}

const COLORS = ["#ff0000", "#00cc00", "#0088ff", "#ffcc00", "#ff6600", "#cc00ff", "#ffffff", "#000000"];
const LINE_WIDTHS = [1, 2, 3, 5, 8, 12];
const FONT_SIZES = [14, 18, 24, 32, 48];
let _nextId = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function annotationBounds(a: Annotation): Rect {
  if (a.points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of a.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = Math.max(a.lineWidth * 2, 8);
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  return {
    ...a,
    points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    bounds: a.bounds ? { ...a.bounds, x: a.bounds.x + dx, y: a.bounds.y + dy } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const ScreenshotOverlay: Component<ScreenshotOverlayProps> = (props) => {
  // --- Phase ---
  const [phase, setPhase] = createSignal<"select" | "annotate">("select");

  // --- Selection ---
  const [selection, setSelection] = createSignal<Rect | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [dragStart, setDragStart] = createSignal<{ x: number; y: number } | null>(null);
  const [dragEnd, setDragEnd] = createSignal<{ x: number; y: number } | null>(null);
  // Move selection
  const [movingSelection, setMovingSelection] = createSignal(false);
  const [moveOffset, setMoveOffset] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
  // Mouse position in VIEWPORT coordinates (for the full-screen
  // crosshair guide lines). We read it on every mousemove while in
  // the "select" phase and clear it once a selection is locked in.
  // Tracked as `null` when the cursor is outside the displayed
  // screenshot rectangle (so the guide lines hide in the black
  // letterbox bars instead of floating over empty space).
  const [crosshairPos, setCrosshairPos] = createSignal<{
    x: number;
    y: number;
    bufferX: number;
    bufferY: number;
  } | null>(null);

  // --- Annotation ---
  const [activeTool, setActiveTool] = createSignal<ToolType>("rect");
  const [activeColor, setActiveColor] = createSignal("#ff0000");
  const [activeLineWidth, setActiveLineWidth] = createSignal(3);
  const [activeFontSize, setActiveFontSize] = createSignal(24);
  // Undo/redo: instead of a flat `annotations` signal, we keep a
  // chronological `history` array where each entry is a complete
  // snapshot of the annotations list. `historyIdx` points at the
  // "current" snapshot. Undo decrements the index; redo increments
  // it; new mutations truncate everything after the current index
  // (so redo is only available if the user hasn't drawn something
  // new after undoing).
  const [history, setHistory] = createSignal<Annotation[][]>([[]]);
  const [historyIdx, setHistoryIdx] = createSignal(0);
  const annotations = () => history()[historyIdx()] ?? [];
  function pushAnnotations(newList: Annotation[]) {
    const h = history().slice(0, historyIdx() + 1);
    h.push(newList);
    setHistory(h);
    setHistoryIdx(h.length - 1);
  }
  const [currentAnnotation, setCurrentAnnotation] = createSignal<Annotation | null>(null);
  // Annotation move
  const [selectedAnnoId, setSelectedAnnoId] = createSignal<number | null>(null);
  const [movingAnno, setMovingAnno] = createSignal(false);
  const [annoMoveStart, setAnnoMoveStart] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });
  // Text
  const [textInput, setTextInput] = createSignal<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const [textValue, setTextValue] = createSignal("");

  // Refs
  let bgCanvasRef: HTMLCanvasElement | undefined;
  let annotateCanvasRef: HTMLCanvasElement | undefined;
  let bgImage: HTMLImageElement | null = null;

  // --- Load background image ---
  onMount(() => {
    bgImage = new Image();
    bgImage.onload = () => {
      if (bgCanvasRef) {
        bgCanvasRef.width = bgImage!.width;
        bgCanvasRef.height = bgImage!.height;
        const ctx = bgCanvasRef.getContext("2d")!;
        ctx.drawImage(bgImage!, 0, 0);
      }
    };
    bgImage.src = `data:image/png;base64,${props.screenshotBase64}`;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    const handleCtrlZ = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && phase() === "annotate") {
        if (e.shiftKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); redo(); }
        else if (!e.shiftKey && e.key === "z") { e.preventDefault(); undo(); }
      }
    };
    document.addEventListener("keydown", handleEsc, true);
    document.addEventListener("keydown", handleCtrlZ, true);
    onCleanup(() => { document.removeEventListener("keydown", handleEsc, true); document.removeEventListener("keydown", handleCtrlZ, true); });
  });

  // ─── Coordinate helpers ────────────────────────────────────────────
  //
  // Both `bgPos` and `annoPos` convert a MouseEvent's client
  // coordinates into the canvas's DRAWING-BUFFER pixel space. The
  // subtlety is that our canvases use `object-fit: contain`, which
  // preserves the content's aspect ratio — when the CSS box has a
  // different aspect ratio than the backing buffer, the content is
  // displayed with LETTERBOX bars on the top/bottom (or sides).
  //
  // This happens often: the screenshot is captured at the primary
  // monitor's raw PHYSICAL pixel resolution (e.g. 1920×1080), but
  // the Tauri window the overlay lives in might be a non-maximized
  // CSS rectangle with a slightly different aspect (e.g. 1200×800).
  // `object-fit: contain` then shows the image at 1200×675 CSS px
  // with 62.5 CSS px of black letterbox on top and bottom.
  //
  // The OLD math `(e.clientX - r.left) * buffer.w / r.width`
  // assumed the content filled `r.width × r.height`, which is only
  // true when the aspect ratios match. In the letterbox case it
  // produced a steady vertical/horizontal offset between where the
  // crosshair cursor visually points and where the selection
  // rectangle actually starts — exactly the "crosshair off by N
  // pixels" bug the user reported.
  //
  // The fix is to compute the displayed-content rectangle inside
  // the element (with the letterbox offsets) and then do the
  // buffer conversion relative to THAT rectangle.
  //
  // Returns `null` if the click is inside the letterbox bars — not
  // strictly necessary for correctness (we clamp to the displayed
  // area below) but nice to document.
  function rectToBufferCoords(
    e: { clientX: number; clientY: number },
    r: DOMRect,
    bufferW: number,
    bufferH: number,
  ): { x: number; y: number } {
    if (bufferW <= 0 || bufferH <= 0 || r.width <= 0 || r.height <= 0) {
      return { x: 0, y: 0 };
    }
    const bufferAspect = bufferW / bufferH;
    const elementAspect = r.width / r.height;
    let displayedW: number;
    let displayedH: number;
    let offsetX: number;
    let offsetY: number;
    if (bufferAspect > elementAspect) {
      // Buffer is WIDER than element → full width, letterbox top/bottom
      displayedW = r.width;
      displayedH = r.width / bufferAspect;
      offsetX = 0;
      offsetY = (r.height - displayedH) / 2;
    } else {
      // Buffer is TALLER (or equal) → full height, letterbox sides
      displayedH = r.height;
      displayedW = r.height * bufferAspect;
      offsetX = (r.width - displayedW) / 2;
      offsetY = 0;
    }
    // Translate into the displayed-content box, then clamp so that
    // clicks in the letterbox bars stick to the edge of the
    // displayed area instead of yielding negative or out-of-range
    // buffer positions.
    const localX = Math.max(0, Math.min(displayedW, e.clientX - r.left - offsetX));
    const localY = Math.max(0, Math.min(displayedH, e.clientY - r.top - offsetY));
    return {
      x: (localX * bufferW) / displayedW,
      y: (localY * bufferH) / displayedH,
    };
  }

  function bgPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    if (!bgCanvasRef || !bgImage) return { x: 0, y: 0 };
    const r = bgCanvasRef.getBoundingClientRect();
    return rectToBufferCoords(e, r, bgImage.width, bgImage.height);
  }

  function annoPos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    if (!annotateCanvasRef) return { x: 0, y: 0 };
    const r = annotateCanvasRef.getBoundingClientRect();
    return rectToBufferCoords(e, r, annotateCanvasRef.width, annotateCanvasRef.height);
  }

  /**
   * For the visible crosshair guide lines: compute the current
   * displayed-content rectangle of `bgCanvasRef` so the guide lines
   * can be clamped to that area (they shouldn't extend into the
   * letterbox bars — those aren't part of the actual screenshot).
   * Returns `null` if the canvas isn't mounted yet.
   */
  function bgDisplayedRect(): DOMRect | null {
    if (!bgCanvasRef || !bgImage) return null;
    const r = bgCanvasRef.getBoundingClientRect();
    if (bgImage.width <= 0 || bgImage.height <= 0) return r;
    const bufferAspect = bgImage.width / bgImage.height;
    const elementAspect = r.width / r.height;
    let displayedW: number;
    let displayedH: number;
    let offsetX: number;
    let offsetY: number;
    if (bufferAspect > elementAspect) {
      displayedW = r.width;
      displayedH = r.width / bufferAspect;
      offsetX = 0;
      offsetY = (r.height - displayedH) / 2;
    } else {
      displayedH = r.height;
      displayedW = r.height * bufferAspect;
      offsetX = (r.width - displayedW) / 2;
      offsetY = 0;
    }
    return new DOMRect(
      r.left + offsetX,
      r.top + offsetY,
      displayedW,
      displayedH,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Phase 1 — Region selection (with move support)
  // ═══════════════════════════════════════════════════════════════════

  function isInsideSelection(pos: { x: number; y: number }): boolean {
    const sel = selection();
    return !!sel && pointInRect(pos.x, pos.y, sel);
  }

  function onSelMouseDown(e: MouseEvent) {
    if (phase() !== "select") return;
    e.preventDefault();
    const pos = bgPos(e);

    // If clicking inside existing selection, start moving it
    if (isInsideSelection(pos)) {
      const sel = selection()!;
      setMovingSelection(true);
      setMoveOffset({ x: pos.x - sel.x, y: pos.y - sel.y });
      return;
    }

    // Start new selection
    setSelection(null);
    setDragStart(pos);
    setDragEnd(pos);
    setDragging(true);
  }

  function onSelMouseMove(e: MouseEvent) {
    // Update the full-screen crosshair guide lines. Only fire when
    // we're NOT mid-drag — once the user commits a selection the
    // guide lines disappear and standard resize/move cursor takes
    // over. We compute BOTH the viewport coords (for positioning
    // the lines) AND the buffer coords (for the tiny `(x, y)`
    // coord label next to the cursor) via the same letterbox-
    // aware `rectToBufferCoords` helper that `bgPos` uses, so the
    // guide lines are pixel-perfect aligned with the underlying
    // screenshot content.
    if (phase() === "select" && !selection() && !dragging() && !movingSelection()) {
      const displayed = bgDisplayedRect();
      if (
        displayed &&
        e.clientX >= displayed.left &&
        e.clientX <= displayed.right &&
        e.clientY >= displayed.top &&
        e.clientY <= displayed.bottom
      ) {
        const buf = bgPos(e);
        setCrosshairPos({
          x: e.clientX,
          y: e.clientY,
          bufferX: Math.round(buf.x),
          bufferY: Math.round(buf.y),
        });
      } else {
        setCrosshairPos(null);
      }
    } else if (crosshairPos()) {
      setCrosshairPos(null);
    }

    if (movingSelection()) {
      const pos = bgPos(e);
      const sel = selection()!;
      const off = moveOffset();
      setSelection({ ...sel, x: pos.x - off.x, y: pos.y - off.y });
      drawSelectionOverlay();
      return;
    }
    if (!dragging()) return;
    setDragEnd(bgPos(e));
    drawSelectionOverlay();
  }

  function onSelMouseLeave() {
    // Hide the guide lines when the cursor leaves the canvas area.
    // Without this they'd be stuck at the last known position,
    // which looks broken.
    if (crosshairPos()) setCrosshairPos(null);
  }

  function onSelMouseUp(_e: MouseEvent) {
    if (movingSelection()) { setMovingSelection(false); return; }
    if (!dragging()) return;
    setDragging(false);
    const s = dragStart(), en = dragEnd();
    if (!s || !en) return;
    const rect: Rect = { x: Math.min(s.x, en.x), y: Math.min(s.y, en.y), w: Math.abs(en.x - s.x), h: Math.abs(en.y - s.y) };
    if (rect.w < 10 || rect.h < 10) return;
    setSelection(rect);
    drawSelectionOverlay();
  }

  function confirmSelection() {
    const sel = selection();
    if (!sel || sel.w < 10 || sel.h < 10) return;
    setPhase("annotate");
    initAnnotateCanvas(sel);
  }

  function onSelDoubleClick(e: MouseEvent) {
    // Double-click inside selection = confirm
    if (isInsideSelection(bgPos(e))) confirmSelection();
  }

  function drawSelectionOverlay() {
    if (!bgCanvasRef || !bgImage) return;
    const ctx = bgCanvasRef.getContext("2d")!;
    ctx.clearRect(0, 0, bgCanvasRef.width, bgCanvasRef.height);
    ctx.drawImage(bgImage!, 0, 0);

    const sel = selection();
    const s = sel || (() => { const st = dragStart(), en = dragEnd(); if (!st || !en) return null; return { x: Math.min(st.x, en.x), y: Math.min(st.y, en.y), w: Math.abs(en.x - st.x), h: Math.abs(en.y - st.y) } as Rect; })();
    if (!s) return;

    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, bgCanvasRef.width, bgCanvasRef.height);
    ctx.clearRect(s.x, s.y, s.w, s.h);
    ctx.drawImage(bgImage!, s.x, s.y, s.w, s.h, s.x, s.y, s.w, s.h);
    ctx.strokeStyle = "#00aaff";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(0,170,255,0.8)";
    ctx.fillRect(s.x, s.y - 24, 120, 22);
    ctx.fillStyle = "#fff";
    ctx.font = "13px system-ui";
    ctx.fillText(`${Math.round(s.w)} x ${Math.round(s.h)}`, s.x + 6, s.y - 7);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Phase 2 — Annotation (with select/move support)
  // ═══════════════════════════════════════════════════════════════════

  function initAnnotateCanvas(rect: Rect) {
    if (!annotateCanvasRef || !bgImage) return;
    annotateCanvasRef.width = rect.w;
    annotateCanvasRef.height = rect.h;
    const ctx = annotateCanvasRef.getContext("2d")!;
    ctx.drawImage(bgImage!, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  }

  function onAnnoMouseDown(e: MouseEvent) {
    if (phase() !== "annotate") return;
    e.preventDefault();
    const pos = annoPos(e);
    const tool = activeTool();

    // "select" tool — pick & move existing annotations
    if (tool === "select") {
      const annos = annotations();
      for (let i = annos.length - 1; i >= 0; i--) {
        const b = annos[i].bounds || annotationBounds(annos[i]);
        if (pointInRect(pos.x, pos.y, b)) {
          setSelectedAnnoId(annos[i].id);
          setMovingAnno(true);
          setAnnoMoveStart(pos);
          return;
        }
      }
      setSelectedAnnoId(null);
      return;
    }

    if (tool === "text") {
      setTextInput({ x: e.clientX, y: e.clientY, visible: true });
      setTextValue("");
      return;
    }

    setCurrentAnnotation({ id: _nextId++, tool, color: activeColor(), lineWidth: activeLineWidth(), points: [pos] });
  }

  function onAnnoMouseMove(e: MouseEvent) {
    // Moving annotation
    if (movingAnno()) {
      const pos = annoPos(e);
      const start = annoMoveStart();
      const dx = pos.x - start.x, dy = pos.y - start.y;
      const id = selectedAnnoId();
      pushAnnotations(annotations().map((a) => a.id === id ? moveAnnotation(a, dx, dy) : a));
      setAnnoMoveStart(pos);
      redrawAnnotations();
      return;
    }

    const curr = currentAnnotation();
    if (!curr) return;
    const pos = annoPos(e);
    if (curr.tool === "freehand" || curr.tool === "mosaic") {
      setCurrentAnnotation({ ...curr, points: [...curr.points, pos] });
    } else {
      setCurrentAnnotation({ ...curr, points: [curr.points[0], pos] });
    }
    redrawAnnotations();
  }

  function onAnnoMouseUp() {
    if (movingAnno()) { setMovingAnno(false); return; }
    const curr = currentAnnotation();
    if (!curr) return;
    if (curr.points.length >= 2) {
      const withBounds = { ...curr, bounds: annotationBounds(curr) };
      pushAnnotations([...annotations(), withBounds]);
    }
    setCurrentAnnotation(null);
    redrawAnnotations();
  }

  function commitText() {
    const txt = textValue().trim();
    if (!txt) { setTextInput({ ...textInput(), visible: false }); return; }
    const pos = annoPos({ clientX: textInput().x, clientY: textInput().y } as MouseEvent);
    const fs = activeFontSize();
    const ann: Annotation = { id: _nextId++, tool: "text", color: activeColor(), lineWidth: activeLineWidth(), points: [pos], text: txt, fontSize: fs };
    ann.bounds = { x: pos.x - 4, y: pos.y - fs - 4, w: txt.length * fs * 0.65, h: fs + 8 };
    pushAnnotations([...annotations(), ann]);
    setTextInput({ ...textInput(), visible: false });
    setTextValue("");
    redrawAnnotations();
  }

  function redrawAnnotations() {
    if (!annotateCanvasRef || !bgImage) return;
    const sel = selection();
    if (!sel) return;
    const ctx = annotateCanvasRef.getContext("2d")!;
    ctx.clearRect(0, 0, annotateCanvasRef.width, annotateCanvasRef.height);
    ctx.drawImage(bgImage!, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    for (const ann of annotations()) drawAnnotation(ctx, ann, ann.id === selectedAnnoId());
    const curr = currentAnnotation();
    if (curr) drawAnnotation(ctx, curr, false);
  }

  function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation, highlight: boolean) {
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const pts = ann.points;
    if (pts.length < 1) { ctx.restore(); return; }

    switch (ann.tool) {
      case "rect": {
        if (pts.length < 2) break;
        ctx.strokeRect(Math.min(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y), Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
        break;
      }
      case "circle": {
        if (pts.length < 2) break;
        const rx = Math.abs(pts[1].x - pts[0].x) / 2, ry = Math.abs(pts[1].y - pts[0].y) / 2;
        ctx.beginPath();
        ctx.ellipse((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "arrow": {
        if (pts.length < 2) break;
        // Arrow head size scales with line width so thin arrows
        // get small heads and thick arrows get large ones. The
        // `Math.max(10, ...)` floor prevents the head from
        // disappearing on the thinnest setting.
        const headSize = Math.max(10, ann.lineWidth * 4);
        const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[1].x - headSize * Math.cos(angle - Math.PI / 6), pts[1].y - headSize * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[1].x - headSize * Math.cos(angle + Math.PI / 6), pts[1].y - headSize * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
        break;
      }
      case "line": {
        if (pts.length < 2) break;
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
        break;
      }
      case "freehand": {
        if (pts.length < 2) break;
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        break;
      }
      case "mosaic": {
        const bs = 12;
        const visited = new Set<string>();
        for (const pt of pts) {
          const bx = Math.floor(pt.x / bs) * bs, by = Math.floor(pt.y / bs) * bs;
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const kx = bx + dx * bs, ky = by + dy * bs, k = `${kx},${ky}`;
            if (visited.has(k)) continue; visited.add(k);
            const d = ctx.getImageData(kx, ky, bs, bs);
            let r = 0, g = 0, b = 0, c = 0;
            for (let i = 0; i < d.data.length; i += 4) { r += d.data[i]; g += d.data[i + 1]; b += d.data[i + 2]; c++; }
            if (c) { ctx.fillStyle = `rgb(${r / c | 0},${g / c | 0},${b / c | 0})`; ctx.fillRect(kx, ky, bs, bs); }
          }
        }
        break;
      }
      case "text":
        if (ann.text && pts.length >= 1) { ctx.font = `${ann.fontSize || 20}px system-ui`; ctx.fillText(ann.text, pts[0].x, pts[0].y); }
        break;
    }

    // Highlight selected annotation
    if (highlight && ann.bounds) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#00aaff";
      ctx.lineWidth = 1;
      ctx.strokeRect(ann.bounds.x, ann.bounds.y, ann.bounds.w, ann.bounds.h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function undo() {
    if (historyIdx() > 0) {
      setHistoryIdx(historyIdx() - 1);
      redrawAnnotations();
    }
  }
  function redo() {
    if (historyIdx() < history().length - 1) {
      setHistoryIdx(historyIdx() + 1);
      redrawAnnotations();
    }
  }

  function confirmScreenshot() {
    if (!annotateCanvasRef) return;
    // Deselect so highlight isn't in output
    setSelectedAnnoId(null);
    redrawAnnotations();
    setTimeout(() => {
      const dataUrl = annotateCanvasRef!.toDataURL("image/png");
      props.onSave(dataUrl.replace(/^data:image\/png;base64,/, ""));
    }, 50);
  }

  // ─── Tool definitions ─────────────────────────────────────────────

  const tools: { id: ToolType; label: string; icon: string }[] = [
    { id: "select", label: t("screenshot.selectMove"), icon: "M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z M13 13l6 6" },
    { id: "rect", label: t("screenshot.rectangle"), icon: "M3 3h18v18H3z" },
    { id: "circle", label: t("screenshot.circle"), icon: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" },
    { id: "arrow", label: t("screenshot.arrow"), icon: "M5 12h14M12 5l7 7-7 7" },
    { id: "line", label: t("screenshot.line"), icon: "M5 19L19 5" },
    { id: "freehand", label: t("screenshot.freehand"), icon: "M12 19l7-7 3 3-7 7-3-3z M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z M2 2l7.586 7.586" },
    { id: "text", label: t("screenshot.text"), icon: "M4 7V4h16v3 M9 20h6 M12 4v16" },
    { id: "mosaic", label: t("screenshot.mosaic"), icon: "M4 4h4v4H4zM12 4h4v4h-4zM4 12h4v4H4zM12 12h4v4h-4zM20 4h0v4h0zM20 12h0v4h0z" },
  ];

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div style={{ position: "fixed", inset: "0", "z-index": "99999", background: "#000", cursor: phase() === "select" ? (selection() && !dragging() ? "default" : "crosshair") : "default", "user-select": "none" }}>

      {/* Phase 1: Selection */}
      <Show when={phase() === "select"}>
        <canvas ref={bgCanvasRef} style={{ position: "absolute", inset: "0", width: "100%", height: "100%", "object-fit": "contain" }}
          onMouseDown={onSelMouseDown} onMouseMove={onSelMouseMove} onMouseUp={onSelMouseUp} onDblClick={onSelDoubleClick} onMouseLeave={onSelMouseLeave} />

        {/* Full-screen crosshair guide lines — follow the mouse
            during the select phase so the user can see EXACTLY
            which pixel they're about to anchor the selection at.
            We draw two 1px fixed-position divs (horizontal +
            vertical) rather than using the browser's native
            `cursor: crosshair` icon, which is small and hard to
            see on a dimmed screenshot. A small coordinate label
            next to the cursor shows the current buffer pixel for
            pixel-perfect positioning. Hidden once the user has
            committed a selection (they no longer need it). */}
        <Show when={crosshairPos() && !selection() && !dragging()}>
          {(() => {
            const p = crosshairPos()!;
            return (
              <>
                <div style={{
                  position: "fixed",
                  left: "0",
                  right: "0",
                  top: `${p.y}px`,
                  height: "1px",
                  background: "rgba(0, 170, 255, 0.8)",
                  "box-shadow": "0 0 0 1px rgba(0, 0, 0, 0.4)",
                  "pointer-events": "none",
                  "z-index": "100000",
                }} />
                <div style={{
                  position: "fixed",
                  top: "0",
                  bottom: "0",
                  left: `${p.x}px`,
                  width: "1px",
                  background: "rgba(0, 170, 255, 0.8)",
                  "box-shadow": "0 0 0 1px rgba(0, 0, 0, 0.4)",
                  "pointer-events": "none",
                  "z-index": "100000",
                }} />
                <div style={{
                  position: "fixed",
                  left: `${p.x + 14}px`,
                  top: `${p.y + 14}px`,
                  padding: "3px 8px",
                  background: "rgba(0, 170, 255, 0.9)",
                  color: "#fff",
                  "font-size": "11px",
                  "font-family": "Consolas, Menlo, monospace",
                  "border-radius": "3px",
                  "pointer-events": "none",
                  "z-index": "100001",
                  "white-space": "nowrap",
                  "box-shadow": "0 2px 6px rgba(0, 0, 0, 0.4)",
                }}>
                  {p.bufferX}, {p.bufferY}
                </div>
              </>
            );
          })()}
        </Show>

        {/* Confirm button appears after selection */}
        <Show when={selection()}>
          <div style={{ position: "absolute", bottom: "20px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "8px" }}>
            <button onClick={props.onClose} style={{ padding: "8px 20px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.3)", "border-radius": "6px", color: "#ddd", cursor: "pointer", "font-size": "14px", "font-family": "system-ui" }}>{t("common.cancel")}</button>
            <button onClick={confirmSelection} style={{ padding: "8px 20px", background: "#00aaff", border: "none", "border-radius": "6px", color: "#fff", cursor: "pointer", "font-size": "14px", "font-family": "system-ui", "font-weight": "600" }}>{t("screenshot.confirmSelection")}</button>
          </div>
        </Show>
        <Show when={!selection()}>
          <div style={{ position: "absolute", bottom: "20px", left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.7)", color: "#fff", padding: "8px 20px", "border-radius": "8px", "font-size": "14px", "font-family": "system-ui", "pointer-events": "none" }}>
            {t("screenshot.selectionHint")}
          </div>
        </Show>
      </Show>

      {/* Phase 2: Annotate */}
      <Show when={phase() === "annotate"}>
        <div style={{ position: "absolute", inset: "0", display: "flex", "flex-direction": "column", "align-items": "center", "justify-content": "center", background: "rgba(0,0,0,0.85)" }}>
          <div style={{ position: "relative", "max-width": "90vw", "max-height": "calc(100vh - 120px)" }}>
            <canvas ref={annotateCanvasRef} style={{ "max-width": "90vw", "max-height": "calc(100vh - 120px)", "object-fit": "contain", cursor: activeTool() === "select" ? "default" : activeTool() === "text" ? "text" : "crosshair", "border-radius": "4px", "box-shadow": "0 4px 20px rgba(0,0,0,0.5)" }}
              onMouseDown={onAnnoMouseDown} onMouseMove={onAnnoMouseMove} onMouseUp={onAnnoMouseUp} />
            <Show when={textInput().visible}>
              <input type="text" value={textValue()} onInput={(e) => setTextValue(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTextInput({ ...textInput(), visible: false }); }}
                autofocus style={{ position: "fixed", left: textInput().x + "px", top: textInput().y + "px", background: "rgba(0,0,0,0.8)", border: `2px solid ${activeColor()}`, color: activeColor(), "font-size": `${activeFontSize()}px`, padding: "4px 8px", "border-radius": "4px", outline: "none", "min-width": "120px", "font-family": "system-ui", "z-index": "100001" }} />
            </Show>
          </div>

          {/* Toolbar */}
          <div style={{ display: "flex", "align-items": "center", gap: "4px", padding: "8px 12px", background: "rgba(40,40,40,0.95)", "border-radius": "10px", "margin-top": "12px", "box-shadow": "0 4px 16px rgba(0,0,0,0.4)", "backdrop-filter": "blur(8px)", "flex-wrap": "wrap", "justify-content": "center", "max-width": "95vw" }}>
            {/* ── Tool buttons ── */}
            {tools.map((t) => (
              <button onClick={() => { setActiveTool(t.id); if (t.id !== "select") setSelectedAnnoId(null); }} title={t.label}
                style={{ width: "36px", height: "36px", border: activeTool() === t.id ? "2px solid #00aaff" : "2px solid transparent", background: activeTool() === t.id ? "rgba(0,170,255,0.15)" : "transparent", "border-radius": "8px", cursor: "pointer", display: "flex", "align-items": "center", "justify-content": "center", transition: "all 100ms" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={activeTool() === t.id ? "#00aaff" : "#ccc"} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d={t.icon} /></svg>
              </button>
            ))}

            {/* ── Colors (preset swatches + custom picker) ── */}
            <div style={{ width: "1px", height: "24px", background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />
            {COLORS.map((c) => (
              <button onClick={() => setActiveColor(c)} style={{ width: "22px", height: "22px", "border-radius": "50%", background: c, border: activeColor() === c ? "3px solid #fff" : "2px solid rgba(255,255,255,0.2)", cursor: "pointer", "flex-shrink": "0" }} />
            ))}
            {/* Custom color picker — the native browser color input
                renders as a small square on click (WebView2 on Windows
                shows a full color wheel dialog). */}
            <div style={{ position: "relative", width: "22px", height: "22px", "flex-shrink": "0" }}>
              <input
                type="color"
                value={activeColor()}
                onInput={(e) => setActiveColor(e.currentTarget.value)}
                title={t("screenshot.customColor") || "Custom color"}
                style={{
                  position: "absolute",
                  inset: "0",
                  width: "100%",
                  height: "100%",
                  padding: "0",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  opacity: "0",
                }}
              />
              {/* Visual label over the invisible <input>: a rainbow
                  gradient circle with a "+" so it's obvious this
                  opens a custom color picker. */}
              <div style={{
                width: "22px",
                height: "22px",
                "border-radius": "50%",
                background: "conic-gradient(#f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
                border: "2px solid rgba(255,255,255,0.3)",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                "pointer-events": "none",
                "font-size": "12px",
                color: "#fff",
                "text-shadow": "0 0 3px #000, 0 0 6px #000",
                "font-weight": "bold",
              }}>+</div>
            </div>

            {/* ── Line widths ── */}
            <div style={{ width: "1px", height: "24px", background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />
            {LINE_WIDTHS.map((lw) => (
              <button onClick={() => setActiveLineWidth(lw)} title={`${lw}px`}
                style={{ width: "30px", height: "30px", border: activeLineWidth() === lw ? "2px solid #00aaff" : "2px solid transparent", background: activeLineWidth() === lw ? "rgba(0,170,255,0.15)" : "transparent", "border-radius": "6px", cursor: "pointer", display: "flex", "align-items": "center", "justify-content": "center" }}>
                <div style={{ width: "16px", height: Math.max(1, lw) + "px", background: activeLineWidth() === lw ? "#00aaff" : "#aaa", "border-radius": lw > 3 ? "2px" : "0" }} />
              </button>
            ))}

            {/* ── Font sizes (only visible when text tool is active) ── */}
            <Show when={activeTool() === "text"}>
              <div style={{ width: "1px", height: "24px", background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />
              {FONT_SIZES.map((fs) => (
                <button onClick={() => setActiveFontSize(fs)} title={`${fs}px`}
                  style={{ "min-width": "28px", height: "28px", border: activeFontSize() === fs ? "2px solid #00aaff" : "2px solid transparent", background: activeFontSize() === fs ? "rgba(0,170,255,0.15)" : "transparent", "border-radius": "6px", cursor: "pointer", display: "flex", "align-items": "center", "justify-content": "center", "font-size": "11px", color: activeFontSize() === fs ? "#00aaff" : "#aaa", "font-family": "system-ui", padding: "0 4px" }}>
                  {fs}
                </button>
              ))}
            </Show>

            {/* ── Undo / Redo ── */}
            <div style={{ width: "1px", height: "24px", background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />
            <button onClick={undo} title={`${t("screenshot.undo")} (Ctrl+Z)`}
              style={{ width: "36px", height: "36px", border: "2px solid transparent", background: "transparent", "border-radius": "8px", cursor: historyIdx() > 0 ? "pointer" : "default", display: "flex", "align-items": "center", "justify-content": "center", opacity: historyIdx() > 0 ? "1" : "0.35" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6M3.51 15a9 9 0 102.13-9.36L1 10" /></svg>
            </button>
            <button onClick={redo} title={`Redo (Ctrl+Shift+Z)`}
              style={{ width: "36px", height: "36px", border: "2px solid transparent", background: "transparent", "border-radius": "8px", cursor: historyIdx() < history().length - 1 ? "pointer" : "default", display: "flex", "align-items": "center", "justify-content": "center", opacity: historyIdx() < history().length - 1 ? "1" : "0.35" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M20.49 15a9 9 0 11-2.13-9.36L23 10" /></svg>
            </button>

            {/* ── Cancel / Confirm ── */}
            <div style={{ width: "1px", height: "24px", background: "rgba(255,255,255,0.15)", margin: "0 6px" }} />
            <button onClick={props.onClose} style={{ padding: "6px 16px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", "border-radius": "6px", color: "#ddd", cursor: "pointer", "font-size": "13px", "font-family": "system-ui" }}>{t("common.cancel")}</button>
            <button onClick={confirmScreenshot} style={{ padding: "6px 16px", background: "#00aaff", border: "none", "border-radius": "6px", color: "#fff", cursor: "pointer", "font-size": "13px", "font-family": "system-ui", "font-weight": "600" }}>{t("common.confirm")}</button>
          </div>
        </div>
      </Show>
    </div>
  );
};

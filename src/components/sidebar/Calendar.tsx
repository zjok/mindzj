import { Component, For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { formatMonthYear, getMonthLabels, getWeekdayLabels, t } from "../../i18n";
import { vaultStore, type VaultEntry } from "../../stores/vault";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";

interface CalendarDay {
  day: number;
  dateStr: string;
  hasNote: boolean;
  isCurrentMonth: boolean;
  isToday: boolean;
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayStr(): string {
  const now = new Date();
  return toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
}

function dailyNotePath(dateStr: string): string {
  const [year, month] = dateStr.split("-");
  return `diary/${year}/${month}/${dateStr}.md`;
}

function collectDiaryDates(entries: VaultEntry[], result: Set<string>) {
  for (const entry of entries) {
    if (entry.is_dir && entry.children) {
      collectDiaryDates(entry.children, result);
      continue;
    }

    if (!entry.relative_path.startsWith("diary/") || entry.extension !== "md") {
      continue;
    }

    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) result.add(match[1]);
  }
}

export const Calendar: Component = () => {
  const [year, setYear] = createSignal(new Date().getFullYear());
  const [month, setMonth] = createSignal(new Date().getMonth());
  // Currently-selected date in the grid (highlighted with an outline).
  // Drives the bottom "New note for selected date" button. Defaults to
  // today on first mount so the bottom button does something useful
  // even before the user clicks anything.
  const [selectedDate, setSelectedDate] = createSignal<string>(todayStr());
  // Currently-hovered date. Tracked as a signal so the background
  // style is computed reactively instead of being mutated imperatively
  // via `event.currentTarget.style`. Imperative mutation has a bug:
  // when the user hovers a day, then clicks it, the day re-renders
  // with `selectedDate === day.dateStr`, and the subsequent mouseLeave
  // is gated on `!isSelected()` and silently no-ops — leaving the
  // hover background stuck on the cell forever. With a signal-driven
  // approach, the background is recomputed on every relevant signal
  // change and there's no stale inline style to forget about.
  const [hoveredDate, setHoveredDate] = createSignal<string | null>(null);
  // Year/month picker popup state
  const [showPicker, setShowPicker] = createSignal(false);
  const [pickerYear, setPickerYear] = createSignal(new Date().getFullYear());
  const [pickerMonth, setPickerMonth] = createSignal(new Date().getMonth());
  // Right-click context menu state
  const [contextMenu, setContextMenu] = createSignal<{
    show: boolean;
    x: number;
    y: number;
    items: MenuItem[];
  }>({ show: false, x: 0, y: 0, items: [] });

  const existingNotes = createMemo(() => {
    const result = new Set<string>();
    collectDiaryDates(vaultStore.fileTree(), result);
    return result;
  });

  const weekdayLabels = createMemo(() => getWeekdayLabels());
  const monthLabels = createMemo(() => getMonthLabels());

  const calendarDays = createMemo<CalendarDay[]>(() => {
    const days: CalendarDay[] = [];
    const now = todayStr();
    const firstDay = new Date(year(), month(), 1);
    const lastDay = new Date(year(), month() + 1, 0);
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    const prevMonthLast = new Date(year(), month(), 0).getDate();
    for (let index = startDow - 1; index >= 0; index -= 1) {
      const day = prevMonthLast - index;
      const prevMonth = month() === 0 ? 11 : month() - 1;
      const prevYear = month() === 0 ? year() - 1 : year();
      const dateStr = toDateStr(prevYear, prevMonth, day);
      days.push({
        day,
        dateStr,
        hasNote: existingNotes().has(dateStr),
        isCurrentMonth: false,
        isToday: dateStr === now,
      });
    }

    for (let day = 1; day <= lastDay.getDate(); day += 1) {
      const dateStr = toDateStr(year(), month(), day);
      days.push({
        day,
        dateStr,
        hasNote: existingNotes().has(dateStr),
        isCurrentMonth: true,
        isToday: dateStr === now,
      });
    }

    const remaining = 42 - days.length;
    for (let day = 1; day <= remaining; day += 1) {
      const nextMonth = month() === 11 ? 0 : month() + 1;
      const nextYear = month() === 11 ? year() + 1 : year();
      const dateStr = toDateStr(nextYear, nextMonth, day);
      days.push({
        day,
        dateStr,
        hasNote: existingNotes().has(dateStr),
        isCurrentMonth: false,
        isToday: dateStr === now,
      });
    }

    return days;
  });

  const goPrevMonth = () => {
    if (month() === 0) {
      setMonth(11);
      setYear((value) => value - 1);
      return;
    }
    setMonth((value) => value - 1);
  };

  const goNextMonth = () => {
    if (month() === 11) {
      setMonth(0);
      setYear((value) => value + 1);
      return;
    }
    setMonth((value) => value + 1);
  };

  const goToday = () => {
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth());
    setSelectedDate(todayStr());
  };

  const openDailyNote = async (dateStr: string) => {
    if (!existingNotes().has(dateStr)) return;
    const path = dailyNotePath(dateStr);
    try {
      await vaultStore.openFile(path);
    } catch (error) {
      console.error("Failed to open daily note:", error);
    }
  };

  // Create the daily note for the given date AND open it. Used by the
  // right-click context menu and the bottom "new note for selected
  // date" button. Idempotent: if the note already exists, just opens
  // it (no overwrite).
  const createOrOpenDailyNote = async (dateStr: string) => {
    const path = dailyNotePath(dateStr);
    // Try to open first — if it exists in the vault, openFile succeeds
    // and we're done. We can't rely solely on `existingNotes()` because
    // the file tree might not have refreshed yet.
    if (existingNotes().has(dateStr)) {
      try {
        await vaultStore.openFile(path);
        return;
      } catch {
        // Fall through and create.
      }
    }

    try {
      const [yyyy, mm] = dateStr.split("-");
      // Best-effort directory creation. `create_dir` is idempotent on
      // existing dirs but errors get bubbled, so we swallow them.
      await invoke("create_dir", { relativePath: "diary" }).catch(() => {});
      await invoke("create_dir", { relativePath: `diary/${yyyy}` }).catch(() => {});
      await invoke("create_dir", { relativePath: `diary/${yyyy}/${mm}` }).catch(() => {});
      await vaultStore.createFile(path, "");
      await vaultStore.openFile(path);
    } catch (error) {
      console.error("Failed to create daily note:", error);
    }
  };

  const handleDayClick = (day: CalendarDay) => {
    // Single-click selects (and jumps month if needed). Double-click
    // (or single-click on a date that already has a note) opens the
    // note. We treat the second click on the same date as "open".
    const wasSelected = selectedDate() === day.dateStr;
    setSelectedDate(day.dateStr);
    // If the user clicked an out-of-month day, also jump the visible
    // month so the selected day stays visible.
    if (!day.isCurrentMonth) {
      const [y, m] = day.dateStr.split("-").map(Number);
      setYear(y);
      setMonth(m - 1);
    }
    // Auto-open if the date already has a note (one click = open).
    // For dates without a note, the user has to use the bottom button
    // or right-click → create.
    if (day.hasNote && wasSelected) {
      void openDailyNote(day.dateStr);
    } else if (day.hasNote) {
      void openDailyNote(day.dateStr);
    }
  };

  const handleDayContextMenu = (event: MouseEvent, day: CalendarDay) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedDate(day.dateStr);
    if (!day.isCurrentMonth) {
      const [y, m] = day.dateStr.split("-").map(Number);
      setYear(y);
      setMonth(m - 1);
    }
    const items: MenuItem[] = [];
    if (day.hasNote) {
      items.push({
        label: t("calendar.openNoteForDate"),
        icon: "📄",
        action: () => void openDailyNote(day.dateStr),
      });
    } else {
      items.push({
        label: t("calendar.newNoteForDate"),
        icon: "✏️",
        action: () => void createOrOpenDailyNote(day.dateStr),
      });
    }
    setContextMenu({ show: true, x: event.clientX, y: event.clientY, items });
  };

  // --- Year/month picker popup -------------------------------------
  const openPicker = () => {
    setPickerYear(year());
    setPickerMonth(month());
    setShowPicker(true);
  };

  const closePicker = () => setShowPicker(false);

  const confirmPicker = () => {
    setYear(pickerYear());
    setMonth(pickerMonth());
    setShowPicker(false);
  };

  // Close picker on outside click — installed lazily while the picker
  // is open so we don't pay the listener cost otherwise.
  let pickerRef: HTMLDivElement | undefined;
  const handleDocClick = (event: MouseEvent) => {
    if (!showPicker()) return;
    if (pickerRef && !pickerRef.contains(event.target as Node)) {
      closePicker();
    }
  };
  document.addEventListener("mousedown", handleDocClick, true);
  onCleanup(() => document.removeEventListener("mousedown", handleDocClick, true));

  // --- Render ------------------------------------------------------
  return (
    <div style={{ padding: "8px", position: "relative" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "8px",
          gap: "4px",
        }}
      >
        <button
          onClick={goPrevMonth}
          title="‹"
          style={navButtonStyle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          ‹
        </button>

        {/* Year/month label is now a clickable button that opens a
            picker popup. Quick-jump to any year/month without having
            to click ‹ / › repeatedly. */}
        <button
          onClick={openPicker}
          title={t("calendar.pickYearMonth")}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--mz-text-primary)",
            cursor: "pointer",
            "font-size": "var(--mz-font-size-sm)",
            "font-weight": "600",
            "font-family": "var(--mz-font-sans)",
            padding: "2px 8px",
            "border-radius": "var(--mz-radius-sm)",
            flex: "1",
          }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {formatMonthYear(year(), month())}
        </button>

        {/* Dedicated "back to today" button — separate from prev/next
            and from the year/month label so it's always one click
            away regardless of how far the user has wandered. */}
        <button
          onClick={goToday}
          title={t("calendar.backToToday")}
          style={navButtonStyle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          ⊙
        </button>

        <button
          onClick={goNextMonth}
          title="›"
          style={navButtonStyle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          ›
        </button>
      </div>

      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(7, 1fr)",
          "text-align": "center",
          "margin-bottom": "4px",
        }}
      >
        <For each={weekdayLabels()}>
          {(weekday) => (
            <div
              style={{
                padding: "2px 0",
                "font-size": "10px",
                color: "var(--mz-text-muted)",
                "font-weight": "500",
              }}
            >
              {weekday}
            </div>
          )}
        </For>
      </div>

      <div
        style={{
          display: "grid",
          "grid-template-columns": "repeat(7, 1fr)",
          gap: "1px",
        }}
      >
        <For each={calendarDays()}>
          {(day) => {
            const isSelected = () => selectedDate() === day.dateStr;
            const isHovered = () => hoveredDate() === day.dateStr;
            // Background priority: today > hover (when not selected) >
            // transparent. Selection is shown via the border, NOT the
            // background, so a selected-and-hovered cell still gets
            // the hover tint to confirm pointer is over it.
            const bgColor = () => {
              if (day.isToday) return "var(--mz-accent)";
              if (isHovered()) return "var(--mz-bg-hover)";
              return "transparent";
            };
            return (
              <button
                onClick={() => handleDayClick(day)}
                onContextMenu={(event) => handleDayContextMenu(event, day)}
                onMouseEnter={() => setHoveredDate(day.dateStr)}
                onMouseLeave={() => {
                    // Only clear if we're still the hovered cell —
                    // protects against out-of-order enter/leave events
                    // when SolidJS re-renders the For mid-hover.
                    if (hoveredDate() === day.dateStr) setHoveredDate(null);
                }}
                title={day.dateStr}
                style={{
                  width: "100%",
                  "aspect-ratio": "1",
                  border: isSelected() && !day.isToday
                    ? "1px solid var(--mz-accent)"
                    : "1px solid transparent",
                  background: bgColor(),
                  color: day.isToday
                    ? "var(--mz-text-on-accent)"
                    : day.isCurrentMonth
                      ? "var(--mz-text-primary)"
                      : "var(--mz-text-muted)",
                  // Now ALL days are clickable (selectable), not just
                  // the ones with existing notes. The cursor reflects
                  // that.
                  cursor: "pointer",
                  "border-radius": "var(--mz-radius-sm)",
                  "font-size": "11px",
                  "font-family": "var(--mz-font-sans)",
                  "font-weight": day.isToday ? "700" : day.hasNote ? "600" : "400",
                  position: "relative",
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  opacity: day.isCurrentMonth ? "1" : "0.4",
                  "box-sizing": "border-box",
                }}
              >
                {day.day}
                <Show when={day.hasNote}>
                  <span
                    style={{
                      position: "absolute",
                      bottom: "2px",
                      left: "50%",
                      transform: "translateX(-50%)",
                      width: "4px",
                      height: "4px",
                      "border-radius": "50%",
                      background: day.isToday ? "var(--mz-text-on-accent)" : "var(--mz-accent)",
                    }}
                  />
                </Show>
              </button>
            );
          }}
        </For>
      </div>

      {/* Bottom action button — creates / opens the note for the
          currently selected date. Shows a different label depending
          on whether the date already has a note. */}
      <button
        onClick={() => void createOrOpenDailyNote(selectedDate())}
        style={{
          width: "100%",
          padding: "8px",
          "margin-top": "8px",
          border: "1px solid var(--mz-border)",
          background: "transparent",
          color: "var(--mz-text-secondary)",
          cursor: "pointer",
          "border-radius": "var(--mz-radius-md)",
          "font-size": "var(--mz-font-size-xs)",
          "font-family": "var(--mz-font-sans)",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.borderColor = "var(--mz-accent)";
          event.currentTarget.style.color = "var(--mz-accent)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.borderColor = "var(--mz-border)";
          event.currentTarget.style.color = "var(--mz-text-secondary)";
        }}
      >
        {selectedDate() === todayStr()
          ? t("calendar.openToday")
          : `${t("calendar.newNoteForSelected")} (${selectedDate()})`}
      </button>

      {/* Year/month picker popup — overlays the calendar grid */}
      <Show when={showPicker()}>
        <div
          ref={pickerRef}
          style={{
            position: "absolute",
            top: "44px",
            left: "8px",
            right: "8px",
            background: "var(--mz-bg-secondary)",
            border: "1px solid var(--mz-border-strong)",
            "border-radius": "var(--mz-radius-md)",
            "box-shadow": "0 8px 24px rgba(0,0,0,0.35)",
            padding: "12px",
            "z-index": "100",
          }}
        >
          <div
            style={{
              "font-size": "11px",
              color: "var(--mz-text-muted)",
              "font-weight": "600",
              "text-transform": "uppercase",
              "letter-spacing": "0.5px",
              "margin-bottom": "6px",
            }}
          >
            {t("calendar.year")}
          </div>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              gap: "8px",
              "margin-bottom": "12px",
            }}
          >
            <button
              onClick={() => setPickerYear((y) => y - 1)}
              style={navButtonStyle}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              ‹
            </button>
            {/*
              Use type="text" instead of type="number" so the browser
              does NOT render the up/down spinner buttons inside the
              input. We do numeric validation ourselves in onInput by
              stripping non-digits and parsing the result. Fixed-width
              (90px) instead of flex:1 so the input doesn't grow and
              push the `›` next-year button outside the popup body.
              The popup is only ~280px wide on the default sidebar,
              and a flex:1 input ate too much horizontal space.
            */}
            <input
              type="text"
              inputMode="numeric"
              value={pickerYear()}
              onInput={(e) => {
                const target = e.currentTarget as HTMLInputElement;
                // Strip anything that isn't a digit, then parse.
                const cleaned = target.value.replace(/[^0-9]/g, "");
                if (cleaned.length === 0) return;
                const v = parseInt(cleaned, 10);
                if (!Number.isNaN(v)) setPickerYear(v);
                // If the user typed a non-digit, write the cleaned
                // value back so the cursor stays at the right place.
                if (cleaned !== target.value) {
                    target.value = cleaned;
                }
              }}
              style={{
                width: "90px",
                "flex-shrink": "0",
                background: "var(--mz-bg-primary)",
                color: "var(--mz-text-primary)",
                border: "1px solid var(--mz-border)",
                "border-radius": "var(--mz-radius-sm)",
                padding: "4px 8px",
                "font-size": "var(--mz-font-size-sm)",
                "font-family": "var(--mz-font-sans)",
                "text-align": "center",
                "box-sizing": "border-box",
              }}
            />
            <button
              onClick={() => setPickerYear((y) => y + 1)}
              style={navButtonStyle}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              ›
            </button>
          </div>

          <div
            style={{
              "font-size": "11px",
              color: "var(--mz-text-muted)",
              "font-weight": "600",
              "text-transform": "uppercase",
              "letter-spacing": "0.5px",
              "margin-bottom": "6px",
            }}
          >
            {t("calendar.month")}
          </div>
          <div
            style={{
              display: "grid",
              "grid-template-columns": "repeat(3, 1fr)",
              gap: "4px",
              "margin-bottom": "12px",
            }}
          >
            <For each={monthLabels()}>
              {(label, idx) => {
                const isPickerMonth = () => pickerMonth() === idx();
                return (
                  <button
                    onClick={() => setPickerMonth(idx())}
                    style={{
                      padding: "6px 4px",
                      border: "1px solid",
                      "border-color": isPickerMonth()
                        ? "var(--mz-accent)"
                        : "var(--mz-border)",
                      background: isPickerMonth()
                        ? "var(--mz-accent-subtle)"
                        : "transparent",
                      color: isPickerMonth()
                        ? "var(--mz-accent)"
                        : "var(--mz-text-primary)",
                      cursor: "pointer",
                      "border-radius": "var(--mz-radius-sm)",
                      "font-size": "11px",
                      "font-family": "var(--mz-font-sans)",
                      "font-weight": isPickerMonth() ? "600" : "400",
                    }}
                    onMouseEnter={(event) => {
                      if (!isPickerMonth()) {
                        event.currentTarget.style.background = "var(--mz-bg-hover)";
                      }
                    }}
                    onMouseLeave={(event) => {
                      if (!isPickerMonth()) {
                        event.currentTarget.style.background = "transparent";
                      }
                    }}
                  >
                    {label}
                  </button>
                );
              }}
            </For>
          </div>

          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={() => {
                const now = new Date();
                setPickerYear(now.getFullYear());
                setPickerMonth(now.getMonth());
              }}
              style={{
                flex: "1",
                padding: "6px",
                border: "1px solid var(--mz-border)",
                background: "transparent",
                color: "var(--mz-text-secondary)",
                cursor: "pointer",
                "border-radius": "var(--mz-radius-sm)",
                "font-size": "var(--mz-font-size-xs)",
                "font-family": "var(--mz-font-sans)",
              }}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
            >
              {t("calendar.backToToday")}
            </button>
            <button
              onClick={confirmPicker}
              style={{
                flex: "1",
                padding: "6px",
                border: "none",
                background: "var(--mz-accent)",
                color: "var(--mz-text-on-accent)",
                cursor: "pointer",
                "border-radius": "var(--mz-radius-sm)",
                "font-size": "var(--mz-font-size-xs)",
                "font-weight": "600",
                "font-family": "var(--mz-font-sans)",
              }}
            >
              {t("calendar.confirm")}
            </button>
          </div>
        </div>
      </Show>

      <Show when={contextMenu().show}>
        <ContextMenu
          x={contextMenu().x}
          y={contextMenu().y}
          items={contextMenu().items}
          onClose={() => setContextMenu((current) => ({ ...current, show: false }))}
        />
      </Show>
    </div>
  );
};

const navButtonStyle = {
  width: "28px",
  height: "28px",
  border: "none",
  background: "transparent",
  color: "var(--mz-text-secondary)",
  cursor: "pointer",
  "border-radius": "var(--mz-radius-sm)",
  "font-size": "16px",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "font-family": "var(--mz-font-sans)",
  "flex-shrink": "0",
} as const;

function hoverIn(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "var(--mz-bg-hover)";
}

function hoverOut(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "transparent";
}

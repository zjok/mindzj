import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { formatMonthYear, getWeekdayLabels, t } from "../../i18n";
import { vaultStore, type VaultEntry } from "../../stores/vault";

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

  const existingNotes = createMemo(() => {
    const result = new Set<string>();
    collectDiaryDates(vaultStore.fileTree(), result);
    return result;
  });

  const weekdayLabels = createMemo(() => getWeekdayLabels());

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

  const openOrCreateTodayNote = async () => {
    const dateStr = todayStr();
    const path = dailyNotePath(dateStr);
    try {
      await vaultStore.openFile(path);
      return;
    } catch {
      // Fall through to create explicitly.
    }

    try {
      const [year, month] = dateStr.split("-");
      await invoke("create_dir", { relativePath: "diary" }).catch(() => {});
      await invoke("create_dir", { relativePath: `diary/${year}` }).catch(() => {});
      await invoke("create_dir", { relativePath: `diary/${year}/${month}` }).catch(() => {});
      await vaultStore.createFile(path, "");
      await vaultStore.openFile(path);
    } catch (error) {
      console.error("Failed to create daily note:", error);
    }
  };

  return (
    <div style={{ padding: "8px" }}>
      <div
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "space-between",
          "margin-bottom": "8px",
        }}
      >
        <button
          onClick={goPrevMonth}
          style={navButtonStyle}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          ‹
        </button>

        <button
          onClick={goToday}
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
          }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {formatMonthYear(year(), month())}
        </button>

        <button
          onClick={goNextMonth}
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
          {(day) => (
            <button
              onClick={() => void openDailyNote(day.dateStr)}
              title={day.dateStr}
              style={{
                width: "100%",
                "aspect-ratio": "1",
                border: "none",
                background: day.isToday ? "var(--mz-accent)" : "transparent",
                color: day.isToday
                  ? "var(--mz-text-on-accent)"
                  : day.isCurrentMonth
                    ? "var(--mz-text-primary)"
                    : "var(--mz-text-muted)",
                cursor: day.hasNote ? "pointer" : "default",
                "border-radius": "var(--mz-radius-sm)",
                "font-size": "11px",
                "font-family": "var(--mz-font-sans)",
                "font-weight": day.isToday ? "700" : day.hasNote ? "600" : "400",
                position: "relative",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                opacity: day.isCurrentMonth ? "1" : "0.4",
              }}
              onMouseEnter={(event) => {
                if (!day.isToday && day.hasNote) {
                  event.currentTarget.style.background = "var(--mz-bg-hover)";
                }
              }}
              onMouseLeave={(event) => {
                if (!day.isToday) {
                  event.currentTarget.style.background = "transparent";
                }
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
          )}
        </For>
      </div>

      <button
        onClick={() => void openOrCreateTodayNote()}
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
        {t("calendar.openToday")}
      </button>
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
  "font-size": "18px",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "font-family": "var(--mz-font-sans)",
} as const;

function hoverIn(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "var(--mz-bg-hover)";
}

function hoverOut(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "transparent";
}

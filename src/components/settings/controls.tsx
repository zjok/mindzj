/**
 * Reusable setting control components for the Settings panel.
 */

import { Component, For, JSX, createEffect, createSignal } from "solid-js";
import { t } from "../../i18n";

interface SettingToggleProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

export const SettingToggle: Component<SettingToggleProps> = (props) => (
  <div style={rowStyle}>
    <div style={{ flex: "1" }}>
      <div style={labelStyle}>{props.label}</div>
      {props.description && <div style={descStyle}>{props.description}</div>}
    </div>
    <button
      onClick={() => props.onChange(!props.value)}
      style={{
        width: "40px",
        height: "22px",
        "border-radius": "11px",
        border: "none",
        background: props.value ? "var(--mz-accent)" : "var(--mz-bg-hover)",
        cursor: "pointer",
        position: "relative",
        transition: "background 150ms ease",
        "flex-shrink": "0",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: props.value ? "20px" : "2px",
          width: "18px",
          height: "18px",
          "border-radius": "50%",
          background: "white",
          transition: "left 150ms ease",
          "box-shadow": "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  </div>
);

interface SettingInputProps {
  label: string;
  description?: string;
  value: string | number;
  type?: "text" | "number" | "password";
  placeholder?: string;
  min?: number;
  max?: number;
  width?: string;
  commitOnBlur?: boolean;
  onChange: (value: string) => void;
}

export const SettingInput: Component<SettingInputProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value ?? ""));

  createEffect(() => {
    setDraft(String(props.value ?? ""));
  });

  const commit = (value: string) => {
    if (props.commitOnBlur) {
      const trimmed = value.trim();
      if (!trimmed) {
        setDraft(String(props.value ?? ""));
        return;
      }
    }
    props.onChange(value);
  };

  return (
    <div style={rowStyle}>
      <div style={{ flex: "1" }}>
        <div style={labelStyle}>{props.label}</div>
        {props.description && <div style={descStyle}>{props.description}</div>}
      </div>
      <input
        type={props.type || "text"}
        value={props.commitOnBlur ? draft() : props.value}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        onInput={(event) => {
          const value = event.currentTarget.value;
          if (props.commitOnBlur) {
            setDraft(value);
            return;
          }
          props.onChange(value);
        }}
        onBlur={(event) => {
          if (!props.commitOnBlur) return;
          commit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (!props.commitOnBlur || event.key !== "Enter") return;
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        }}
        style={{ ...inputStyle, width: props.width || inputStyle.width }}
      />
    </div>
  );
};

interface SettingSelectProps {
  label: string;
  description?: string;
  value: string;
  options: { value: string; label: string }[];
  width?: string;
  onChange: (value: string) => void;
}

export const SettingSelect: Component<SettingSelectProps> = (props) => (
  <div style={rowStyle}>
    <div style={{ flex: "1" }}>
      <div style={labelStyle}>{props.label}</div>
      {props.description && <div style={descStyle}>{props.description}</div>}
    </div>
    <select
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      style={{
        ...inputStyle,
        width: props.width || "160px",
        cursor: "pointer",
      }}
    >
      <For each={props.options}>
        {(option) => <option value={option.value}>{option.label}</option>}
      </For>
    </select>
  </div>
);

interface SettingColorProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
}

export const SettingColor: Component<SettingColorProps> = (props) => (
  <div style={rowStyle}>
    <div style={{ flex: "1" }}>
      <div style={labelStyle}>{props.label}</div>
      {props.description && <div style={descStyle}>{props.description}</div>}
    </div>
    <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
      <input
        type="color"
        value={props.value || "#528bff"}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        style={{
          width: "32px",
          height: "32px",
          border: "1px solid var(--mz-border)",
          "border-radius": "var(--mz-radius-sm)",
          background: "transparent",
          cursor: "pointer",
          padding: "0",
        }}
      />
      {props.onClear && (
        <button
          onClick={props.onClear}
          style={{
            border: "1px solid var(--mz-border)",
            background: "transparent",
            color: "var(--mz-text-muted)",
            "border-radius": "var(--mz-radius-sm)",
            padding: "4px 8px",
            cursor: "pointer",
            "font-size": "var(--mz-font-size-xs)",
            "font-family": "var(--mz-font-sans)",
          }}
        >
          {t("common.reset")}
        </button>
      )}
    </div>
  </div>
);

export const SettingSection: Component<{
  title: string;
  children: JSX.Element;
}> = (props) => (
  <div style={{ "margin-bottom": "24px" }}>
    <h3
      style={{
        "font-size": "var(--mz-font-size-sm)",
        "font-weight": "600",
        color: "var(--mz-text-muted)",
        "text-transform": "uppercase",
        "letter-spacing": "0.5px",
        "margin-bottom": "12px",
        "padding-bottom": "6px",
        "border-bottom": "1px solid var(--mz-border)",
      }}
    >
      {props.title}
    </h3>
    {props.children}
  </div>
);

interface SettingSliderProps {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onReset?: () => void;
  onChange: (value: number) => void;
}

export const SettingSlider: Component<SettingSliderProps> = (props) => (
  <div style={rowStyle}>
    <div style={{ flex: "1" }}>
      <div style={labelStyle}>{props.label}</div>
      {props.description && <div style={descStyle}>{props.description}</div>}
    </div>
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "8px",
        "flex-shrink": "0",
      }}
    >
      <span
        style={{
          "min-width": "3em",
          "text-align": "right",
          "font-size": "var(--mz-font-size-sm)",
          color: "var(--mz-text-primary)",
        }}
      >
        {props.value}
        {props.suffix || ""}
      </span>
      {props.onReset && (
        <button
          onClick={props.onReset}
          title={t("common.reset")}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--mz-text-muted)",
            padding: "2px",
            display: "flex",
            "align-items": "center",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M1 4v6h6M23 20v-6h-6" />
            <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
          </svg>
        </button>
      )}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step || 1}
        value={props.value}
        onInput={(event) => props.onChange(parseInt(event.currentTarget.value))}
        style={{ width: "100px", cursor: "pointer" }}
      />
    </div>
  </div>
);

const rowStyle: JSX.CSSProperties = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  padding: "8px 0",
  gap: "16px",
  "min-height": "40px",
};

const labelStyle: JSX.CSSProperties = {
  "font-size": "var(--mz-font-size-sm)",
  color: "var(--mz-text-primary)",
  "font-weight": "500",
};

const descStyle: JSX.CSSProperties = {
  "font-size": "var(--mz-font-size-xs)",
  color: "var(--mz-text-muted)",
  "margin-top": "2px",
};

const inputStyle: JSX.CSSProperties = {
  width: "120px",
  padding: "4px 8px",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-sm)",
  background: "var(--mz-bg-primary)",
  color: "var(--mz-text-primary)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  "flex-shrink": "0",
};

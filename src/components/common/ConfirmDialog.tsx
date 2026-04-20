/**
 * Custom themed dialogs replacing native confirm()/prompt().
 */

import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { t } from "../../i18n";

const backdropStyle = {
  position: "fixed",
  inset: "0",
  "z-index": "20000",
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  background: "rgba(0,0,0,0.45)",
} as const;

const panelStyle = {
  background: "var(--mz-bg-secondary)",
  border: "1px solid var(--mz-border-strong)",
  "border-radius": "var(--mz-radius-lg, 8px)",
  "box-shadow": "0 12px 40px rgba(0,0,0,0.35)",
  padding: "20px 24px",
  "min-width": "320px",
  "max-width": "420px",
  "font-family": "var(--mz-font-sans)",
} as const;

const btnBase = {
  padding: "6px 16px",
  "border-radius": "var(--mz-radius-sm, 4px)",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
} as const;

/**
 * Options for customising the confirm dialog.
 *
 *   - `confirmLabel` / `cancelLabel` — override the default button
 *     text. If omitted, the dialog falls back to the delete-flavoured
 *     labels historically used by most call sites (cancel +
 *     red-styled delete) for back-compat.
 *   - `variant` — `"danger"` (red confirm, the default) vs
 *     `"primary"` (accent-coloured confirm). Used for non-destructive
 *     flows like Replace-All where the red delete styling is too
 *     alarming.
 */
export interface ConfirmDialogOptions {
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
}

interface ConfirmState {
  show: boolean;
  message: string;
  confirmLabel: string | null;
  cancelLabel: string | null;
  variant: "danger" | "primary";
  resolve: ((yes: boolean) => void) | null;
}

const [confirmState, setConfirmState] = createSignal<ConfirmState>({
  show: false,
  message: "",
  confirmLabel: null,
  cancelLabel: null,
  variant: "danger",
  resolve: null,
});

export function confirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    setConfirmState({
      show: true,
      message,
      confirmLabel: options?.confirmLabel ?? null,
      cancelLabel: options?.cancelLabel ?? null,
      variant: options?.variant ?? "danger",
      resolve,
    });
  });
}

function closeConfirm(result: boolean) {
  const state = confirmState();
  state.resolve?.(result);
  setConfirmState({
    show: false,
    message: "",
    confirmLabel: null,
    cancelLabel: null,
    variant: "danger",
    resolve: null,
  });
}

interface PromptState {
  show: boolean;
  label: string;
  value: string;
  resolve: ((value: string | null) => void) | null;
}

const [promptState, setPromptState] = createSignal<PromptState>({
  show: false,
  label: "",
  value: "",
  resolve: null,
});

export function promptDialog(
  label: string,
  defaultValue = "",
): Promise<string | null> {
  return new Promise((resolve) => {
    setPromptState({ show: true, label, value: defaultValue, resolve });
  });
}

function closePrompt(result: string | null) {
  const state = promptState();
  state.resolve?.(result);
  setPromptState({ show: false, label: "", value: "", resolve: null });
}

export const ConfirmDialog: Component = () => {
  let confirmBackdropRef: HTMLDivElement | undefined;

  const handleConfirmEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeConfirm(false);
  };

  const handlePromptEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePrompt(null);
  };

  createEffect(() => {
    if (!confirmState().show && !promptState().show) return;

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();

      if (confirmState().show) {
        closeConfirm(false);
        return;
      }

      if (promptState().show) {
        closePrompt(null);
      }
    };

    document.addEventListener("keydown", handleKeydown, true);
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeydown, true);
    });
  });

  createEffect(() => {
    if (confirmState().show) {
      setTimeout(() => confirmBackdropRef?.focus(), 0);
    }
  });

  return (
    <>
      <Show when={confirmState().show}>
        <div
          ref={(element) => {
            confirmBackdropRef = element;
          }}
          style={backdropStyle}
          tabIndex={-1}
          onKeyDown={handleConfirmEscape}
          onClick={() => closeConfirm(false)}
        >
          <div onClick={(event) => event.stopPropagation()} style={panelStyle}>
            <div
              style={{
                "font-size": "var(--mz-font-size-base, 14px)",
                color: "var(--mz-text-primary)",
                "margin-bottom": "20px",
                "line-height": "1.5",
              }}
            >
              {confirmState().message}
            </div>
            <div
              style={{
                display: "flex",
                "justify-content": "flex-end",
                gap: "8px",
              }}
            >
              <button
                onClick={() => closeConfirm(false)}
                style={{
                  ...btnBase,
                  border: "1px solid var(--mz-border)",
                  background: "var(--mz-bg-tertiary)",
                  color: "var(--mz-text-secondary)",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-tertiary)";
                }}
              >
                {confirmState().cancelLabel ?? t("common.cancel")}
              </button>
              <button
                ref={(element) => setTimeout(() => element.focus(), 0)}
                onClick={() => closeConfirm(true)}
                style={{
                  ...btnBase,
                  border: `1px solid ${confirmState().variant === "primary" ? "var(--mz-accent)" : "var(--mz-error)"}`,
                  background: confirmState().variant === "primary" ? "var(--mz-accent)" : "var(--mz-error)",
                  color: "#fff",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.opacity = "0.85";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.opacity = "1";
                }}
              >
                {confirmState().confirmLabel ?? t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={promptState().show}>
        <div
          style={backdropStyle}
          tabIndex={-1}
          onKeyDown={handlePromptEscape}
          onClick={() => closePrompt(null)}
        >
          <div onClick={(event) => event.stopPropagation()} style={panelStyle}>
            <div
              style={{
                "font-size": "var(--mz-font-size-base, 14px)",
                color: "var(--mz-text-primary)",
                "margin-bottom": "12px",
              }}
            >
              {promptState().label}
            </div>
            <input
              ref={(element) =>
                setTimeout(() => {
                  element.focus();
                  element.select();
                }, 0)
              }
              value={promptState().value}
              onInput={(event) =>
                setPromptState((state) => ({
                  ...state,
                  value: event.currentTarget.value,
                }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  closePrompt(promptState().value || null);
                }
                if (event.key === "Escape") {
                  closePrompt(null);
                }
              }}
              style={{
                width: "100%",
                padding: "8px 10px",
                border: "1px solid var(--mz-border)",
                "border-radius": "var(--mz-radius-sm, 4px)",
                background: "var(--mz-bg-primary)",
                color: "var(--mz-text-primary)",
                "font-size": "var(--mz-font-size-sm)",
                "font-family": "var(--mz-font-sans)",
                outline: "none",
                "box-sizing": "border-box",
                "margin-bottom": "16px",
              }}
            />
            <div
              style={{
                display: "flex",
                "justify-content": "flex-end",
                gap: "8px",
              }}
            >
              <button
                onClick={() => closePrompt(null)}
                style={{
                  ...btnBase,
                  border: "1px solid var(--mz-border)",
                  background: "var(--mz-bg-tertiary)",
                  color: "var(--mz-text-secondary)",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-tertiary)";
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => closePrompt(promptState().value || null)}
                style={{
                  ...btnBase,
                  border: "1px solid var(--mz-accent)",
                  background: "var(--mz-accent)",
                  color: "#fff",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.opacity = "0.85";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.opacity = "1";
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
};

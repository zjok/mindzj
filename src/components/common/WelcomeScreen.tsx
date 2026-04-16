import { Component, For, Show, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getLanguageOptions, t } from "../../i18n";
import { settingsStore } from "../../stores/settings";
import { vaultStore } from "../../stores/vault";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { promptDialog } from "./ConfirmDialog";

interface VaultRecord {
  name: string;
  path: string;
  lastOpened: number;
}

const VERSION = "v0.1.0";

export const WelcomeScreen: Component = () => {
  const [vaults, setVaults] = createSignal<VaultRecord[]>([]);
  const [isOpening, setIsOpening] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [showLangDropdown, setShowLangDropdown] = createSignal(false);
  const [contextMenu, setContextMenu] = createSignal<{
    show: boolean;
    x: number;
    y: number;
    items: MenuItem[];
  }>({ show: false, x: 0, y: 0, items: [] });

  onMount(() => {
    try {
      const saved = localStorage.getItem("mindzj-vault-list");
      if (saved) setVaults(JSON.parse(saved));
    } catch {
      setVaults([]);
    }
  });

  const saveVaultList = (list: VaultRecord[]) => {
    setVaults(list);
    localStorage.setItem("mindzj-vault-list", JSON.stringify(list));
  };

  const clearLastVaultIfRemoved = (path: string) => {
    try {
      const saved = localStorage.getItem("mindzj-last-vault");
      if (!saved) return;
      const lastVault = JSON.parse(saved) as { path?: string };
      if (lastVault.path === path) {
        localStorage.removeItem("mindzj-last-vault");
      }
    } catch {
      localStorage.removeItem("mindzj-last-vault");
    }
  };

  const addVaultToList = (name: string, path: string) => {
    const list = vaults().filter((vault) => vault.path !== path);
    list.unshift({ name, path, lastOpened: Date.now() });
    saveVaultList(list);
  };

  const removeVaultFromList = (path: string) => {
    clearLastVaultIfRemoved(path);
    saveVaultList(vaults().filter((vault) => vault.path !== path));
  };

  const renameVault = async (path: string) => {
    const vault = vaults().find((entry) => entry.path === path);
    if (!vault) return;

    const nextName = await promptDialog(t("welcome.renameVaultPrompt"), vault.name);
    if (!nextName || nextName === vault.name) return;

    saveVaultList(
      vaults().map((entry) =>
        entry.path === path ? { ...entry, name: nextName } : entry,
      ),
    );
  };

  const openVaultByPath = async (path: string, name: string) => {
    setIsOpening(true);
    setErrorMsg(null);
    try {
      await vaultStore.openVault(path, name);
      addVaultToList(name, path);
    } catch (error: any) {
      setErrorMsg(error?.message || t("welcome.openVaultError"));
    } finally {
      setIsOpening(false);
    }
  };

  const handleOpenLocalVault = async () => {
    setIsOpening(true);
    setErrorMsg(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("welcome.selectVaultFolder"),
      });

      if (selected && typeof selected === "string") {
        const name = selected.split(/[/\\]/).pop() || t("app.vaultNameFallback");
        await vaultStore.openVault(selected, name);
        addVaultToList(name, selected);
      }
    } catch (error: any) {
      setErrorMsg(error?.message || t("welcome.openVaultError"));
    } finally {
      setIsOpening(false);
    }
  };

  const handleCreateNewVault = async () => {
    setIsOpening(true);
    setErrorMsg(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("welcome.selectNewVaultLocation"),
      });

      if (selected && typeof selected === "string") {
        const vaultName = await promptDialog(
          t("welcome.vaultNamePrompt"),
          "My Vault",
        );
        if (!vaultName) {
          setIsOpening(false);
          return;
        }

        addVaultToList(vaultName, selected);
        await vaultStore.openVault(selected, vaultName);
      }
    } catch (error: any) {
      setErrorMsg(error?.message || t("welcome.createVaultError"));
    } finally {
      setIsOpening(false);
    }
  };

  const showInExplorer = async (path: string) => {
    // We cannot use `@tauri-apps/plugin-shell`'s `open()` here because
    // its default `shell:allow-open` permission only accepts URL-like
    // strings (http/https/mailto/tel) — Windows absolute paths fail the
    // validator silently. And the existing `reveal_in_file_manager`
    // Rust command requires an already-opened vault context (which
    // doesn't exist on the welcome screen), plus it uses `/select,`
    // which opens the PARENT of the folder instead of entering it.
    //
    // The new `open_path_in_file_manager` Rust command takes an
    // absolute path and spawns `explorer "<path>"` on Windows (or
    // `open` / `xdg-open` on the other platforms), so the user lands
    // inside the vault directory — which is what "Show vault folder
    // in file manager" should obviously do.
    try {
      await invoke("open_path_in_file_manager", { absolutePath: path });
    } catch (error) {
      console.error("Failed to reveal vault in file manager:", error);
      // Last-resort fallback: copy the path so the user can paste it
      // into their own file manager.
      try {
        await navigator.clipboard.writeText(path);
        window.alert(t("welcome.copiedPathNotice", { path }));
      } catch (copyError) {
        console.error("Clipboard fallback also failed:", copyError);
      }
    }
  };

  const handleVaultContextMenu = (event: MouseEvent, vault: VaultRecord) => {
    event.preventDefault();
    event.stopPropagation();

    setContextMenu({
      show: true,
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: t("welcome.showVaultInExplorer"),
          icon: "📂",
          action: () => void showInExplorer(vault.path),
        },
        {
          label: t("welcome.renameVault"),
          icon: "✎",
          action: () => void renameVault(vault.path),
          separator: true,
        },
        {
          label: t("welcome.removeVault"),
          icon: "🗑",
          action: () => removeVaultFromList(vault.path),
          danger: true,
          separator: true,
        },
      ],
    });
  };

  const currentLanguageLabel = () =>
    getLanguageOptions().find(
      (item) => item.value === settingsStore.settings().locale,
    )?.label || getLanguageOptions()[0].label;

  return (
    <div
      style={{
        flex: "1",
        display: "flex",
        width: "100%",
        height: "100%",
        background: "var(--mz-bg-primary)",
        "font-family": "var(--mz-font-sans)",
      }}
    >
      <div
        style={{
          width: "320px",
          "min-width": "280px",
          background: "var(--mz-bg-secondary)",
          "border-right": "1px solid var(--mz-border)",
          display: "flex",
          "flex-direction": "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 16px 12px",
            "font-size": "var(--mz-font-size-xs)",
            "font-weight": "600",
            color: "var(--mz-text-muted)",
            "text-transform": "uppercase",
            "letter-spacing": "0.5px",
            "border-bottom": "1px solid var(--mz-border)",
          }}
        >
          {t("welcome.vaultList")}
        </div>

        <div style={{ flex: "1", overflow: "auto" }}>
          <Show
            when={vaults().length > 0}
            fallback={
              <div
                style={{
                  padding: "40px 16px",
                  "text-align": "center",
                  color: "var(--mz-text-muted)",
                  "font-size": "var(--mz-font-size-sm)",
                }}
              >
                <div style={{ "margin-bottom": "10px", "font-size": "28px", opacity: "0.3" }}>
                  🗂
                </div>
                <div>{t("welcome.noVaults")}</div>
                <div
                  style={{
                    "font-size": "var(--mz-font-size-xs)",
                    "margin-top": "6px",
                    opacity: "0.6",
                  }}
                >
                  {t("welcome.noVaultsDescription")}
                </div>
              </div>
            }
          >
            <For each={vaults()}>
              {(vault) => (
                <div
                  onClick={() => void openVaultByPath(vault.path, vault.name)}
                  onContextMenu={(event) => handleVaultContextMenu(event, vault)}
                  style={{
                    padding: "12px 16px",
                    cursor: "pointer",
                    "border-bottom": "1px solid var(--mz-border)",
                    "user-select": "none",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "var(--mz-bg-hover)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "10px",
                      "margin-bottom": "4px",
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 20 20"
                      fill="none"
                      style={{ "flex-shrink": "0" }}
                    >
                      <rect
                        x="2"
                        y="4"
                        width="16"
                        height="13"
                        rx="2"
                        stroke="var(--mz-accent)"
                        stroke-width="1.5"
                        fill="none"
                      />
                      <path d="M2 7H18" stroke="var(--mz-accent)" stroke-width="1.5" />
                    </svg>
                    <span
                      style={{
                        "font-size": "var(--mz-font-size-sm)",
                        "font-weight": "500",
                        color: "var(--mz-text-primary)",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                      }}
                    >
                      {vault.name}
                    </span>
                  </div>
                  <div
                    style={{
                      "font-size": "11px",
                      color: "var(--mz-text-muted)",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      "padding-left": "28px",
                    }}
                  >
                    {vault.path}
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>

      <div
        style={{
          flex: "1",
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "center",
          gap: "12px",
          padding: "40px",
          position: "relative",
        }}
      >
        <img
          src="/mindzj-logo.png"
          alt="MindZJ logo"
          width="64"
          height="64"
          style={{
            width: "64px",
            height: "64px",
            "border-radius": "12px",
            "image-rendering": "auto",
            "user-select": "none",
            "-webkit-user-drag": "none",
          }}
        />

        <div
          style={{
            "font-size": "64px",
            "font-weight": "800",
            color: "var(--mz-text-primary)",
            "letter-spacing": "-3px",
            "line-height": "1",
            "margin-bottom": "4px",
          }}
        >
          Mind<span style={{ color: "var(--mz-accent)" }}>ZJ</span>
        </div>

        <div
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-muted)",
            "margin-bottom": "4px",
          }}
        >
          {t("welcome.tagline")}
        </div>

        <div
          style={{
            "font-size": "var(--mz-font-size-xs)",
            color: "var(--mz-text-muted)",
            background: "var(--mz-bg-secondary)",
            padding: "2px 10px",
            "border-radius": "var(--mz-radius-full)",
            "margin-bottom": "32px",
            opacity: "0.7",
          }}
        >
          {VERSION}
        </div>

        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "12px",
            width: "260px",
          }}
        >
          <button
            onClick={() => void handleCreateNewVault()}
            disabled={isOpening()}
            style={primaryButtonStyle(isOpening())}
            onMouseEnter={(event) => {
              if (!isOpening()) event.currentTarget.style.opacity = "0.85";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.opacity = isOpening() ? "0.6" : "1";
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect
                x="2"
                y="3"
                width="14"
                height="12"
                rx="2"
                stroke="currentColor"
                stroke-width="1.5"
                fill="none"
              />
              <path
                d="M9 7V11M7 9H11"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            {t("welcome.createNewVault")}
          </button>

          <button
            onClick={() => void handleOpenLocalVault()}
            disabled={isOpening()}
            style={secondaryButtonStyle}
            onMouseEnter={(event) => {
              event.currentTarget.style.borderColor = "var(--mz-accent)";
              event.currentTarget.style.color = "var(--mz-accent)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.borderColor = "var(--mz-border-strong)";
              event.currentTarget.style.color = "var(--mz-text-primary)";
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M3 9H12M12 9L9 6M12 9L9 12"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M15 3V15"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            {isOpening() ? t("welcome.opening") : t("welcome.openLocalVault")}
          </button>
        </div>

        <div style={{ "margin-top": "24px", position: "relative" }}>
          <button
            onClick={() => setShowLangDropdown((value) => !value)}
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              padding: "6px 14px",
              border: "1px solid var(--mz-border)",
              background: "transparent",
              "border-radius": "var(--mz-radius-md)",
              cursor: "pointer",
              "font-size": "var(--mz-font-size-xs)",
              "font-family": "var(--mz-font-sans)",
              color: "var(--mz-text-secondary)",
            }}
          >
            <span>🌐</span>
            <span>{currentLanguageLabel()}</span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <path d="M2 4L5 7L8 4" />
            </svg>
          </button>

          <Show when={showLangDropdown()}>
            <div
              style={{
                position: "absolute",
                bottom: "100%",
                left: "50%",
                transform: "translateX(-50%)",
                "margin-bottom": "4px",
                "min-width": "160px",
                background: "var(--mz-bg-secondary)",
                border: "1px solid var(--mz-border-strong)",
                "border-radius": "var(--mz-radius-md)",
                "box-shadow": "0 8px 24px rgba(0,0,0,0.25)",
                padding: "4px 0",
                "z-index": "100",
              }}
            >
              <For each={getLanguageOptions()}>
                {(lang) => (
                  <button
                    onClick={() => {
                      // 1. Update the in-memory setting so the welcome
                      //    screen label updates immediately. The backend
                      //    invoke inside updateSetting will silently fail
                      //    (no vault is open yet) — that's OK, we care
                      //    about the in-memory state here.
                      void settingsStore.updateSetting("locale", lang.value);
                      // 2. Remember the selection so the next vault that
                      //    gets opened (typically a fresh vault the user
                      //    is about to create) picks it up and persists
                      //    it into its own settings.json. App.tsx's
                      //    vault-open effect consumes this key.
                      try {
                        localStorage.setItem(
                          "mindzj-pending-locale",
                          lang.value,
                        );
                      } catch {
                        // localStorage may throw in private mode —
                        // best-effort only.
                      }
                      setShowLangDropdown(false);
                    }}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      width: "100%",
                      padding: "6px 12px",
                      border: "none",
                      background:
                        settingsStore.settings().locale === lang.value
                          ? "var(--mz-bg-active)"
                          : "transparent",
                      color: "var(--mz-text-primary)",
                      cursor: "pointer",
                      "font-size": "var(--mz-font-size-xs)",
                      "font-family": "var(--mz-font-sans)",
                      "text-align": "left",
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.background = "var(--mz-bg-hover)";
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background =
                        settingsStore.settings().locale === lang.value
                          ? "var(--mz-bg-active)"
                          : "transparent";
                    }}
                  >
                    {lang.label}
                    <Show when={settingsStore.settings().locale === lang.value}>
                      <span style={{ color: "var(--mz-accent)" }}>✓</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={errorMsg()}>
          <div
            style={{
              "font-size": "var(--mz-font-size-xs)",
              color: "var(--mz-error)",
              "margin-top": "8px",
              "max-width": "300px",
              "text-align": "center",
            }}
          >
            {errorMsg()}
          </div>
        </Show>

        <div
          style={{
            position: "absolute",
            bottom: "16px",
            "font-size": "11px",
            color: "var(--mz-text-muted)",
            opacity: "0.5",
          }}
        >
          {t("welcome.shortcutsHint")}
        </div>
      </div>

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

const primaryButtonStyle = (disabled: boolean) =>
  ({
    display: "flex",
    "align-items": "center",
    gap: "12px",
    padding: "14px 20px",
    background: "var(--mz-accent)",
    color: "var(--mz-text-on-accent)",
    border: "none",
    "border-radius": "var(--mz-radius-lg)",
    "font-size": "var(--mz-font-size-sm)",
    "font-family": "var(--mz-font-sans)",
    "font-weight": "500",
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? "0.6" : "1",
  }) as const;

const secondaryButtonStyle = {
  display: "flex",
  "align-items": "center",
  gap: "12px",
  padding: "14px 20px",
  background: "transparent",
  color: "var(--mz-text-primary)",
  border: "1px solid var(--mz-border-strong)",
  "border-radius": "var(--mz-radius-lg)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  "font-weight": "500",
  cursor: "pointer",
} as const;

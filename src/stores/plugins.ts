import { createSignal, createRoot } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { vaultStore } from "./vault";
import { toVaultAssetUrl } from "../utils/vaultPaths";

function getScopedPluginLocalStorageKey(pluginId: string, key: string) {
    const vaultScope = encodeURIComponent(
        (vaultStore.vaultInfo()?.path ?? "__no_vault__").replace(/\\/g, "/"),
    );
    return `mindzj-vault-${vaultScope}-plugin-${pluginId}-${key}`;
}

// ---------------------------------------------------------------------------
// Obsidian DOM Extensions — monkey-patch HTMLElement.prototype
// ---------------------------------------------------------------------------
// Obsidian extends HTMLElement with helper methods. Many plugins rely on these.
// Install them once before any plugin code executes.

let _domExtensionsInstalled = false;

function installObsidianDomExtensions() {
    if (_domExtensionsInstalled) return;
    _domExtensionsInstalled = true;

    (globalThis as any).activeWindow = window;
    (globalThis as any).activeDocument = document;

    // Global Obsidian helper functions — create DETACHED elements (not appended).
    // Obsidian's global createEl/createDiv/createSpan return free-floating elements.
    // This is different from HTMLElement.prototype.createEl which appends to `this`.
    function _globalCreateEl(tag: string, o?: any): HTMLElement {
        const el = document.createElement(tag);
        if (o) {
            if (typeof o === "string") {
                el.className = o;
            } else {
                if (o.cls) {
                    if (Array.isArray(o.cls)) el.className = o.cls.join(" ");
                    else el.className = o.cls;
                }
                if (o.text) el.textContent = o.text;
                if (o.attr) {
                    for (const [k, v] of Object.entries(o.attr)) {
                        el.setAttribute(k, v as string);
                    }
                }
                if (o.title) el.title = o.title;
                if (o.value !== undefined) (el as any).value = o.value;
                if (o.type) el.setAttribute("type", o.type);
                if (o.href) el.setAttribute("href", o.href);
                if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
                if (o.parent && o.parent instanceof HTMLElement) {
                    o.parent.appendChild(el);
                }
            }
        }
        return el;
    }
    if (!(globalThis as any).createEl) {
        (globalThis as any).createEl = _globalCreateEl;
    }
    if (!(globalThis as any).createDiv) {
        (globalThis as any).createDiv = (o?: any) => _globalCreateEl("div", o);
    }
    if (!(globalThis as any).createSpan) {
        (globalThis as any).createSpan = (o?: any) => _globalCreateEl("span", o);
    }
    if (!(globalThis as any).createFragment) {
        (globalThis as any).createFragment = () => document.createDocumentFragment();
    }

    const proto = HTMLElement.prototype as any;

    // .empty() — remove all child nodes
    if (!proto.empty) {
        proto.empty = function (this: HTMLElement) {
            while (this.firstChild) this.removeChild(this.firstChild);
        };
    }

    // .createEl(tag, options?) — create an element, configure it, and append
    if (!proto.createEl) {
        proto.createEl = function (this: HTMLElement, tag: string, o?: any) {
            const el = document.createElement(tag);
            if (o) {
                if (typeof o === "string") {
                    // createEl("div", "class-name")
                    el.className = o;
                } else {
                    if (o.cls) {
                        if (Array.isArray(o.cls)) el.className = o.cls.join(" ");
                        else el.className = o.cls;
                    }
                    if (o.text) el.textContent = o.text;
                    if (o.attr) {
                        for (const [k, v] of Object.entries(o.attr)) {
                            el.setAttribute(k, v as string);
                        }
                    }
                    if (o.title) el.title = o.title;
                    if (o.value !== undefined) (el as any).value = o.value;
                    if (o.type) el.setAttribute("type", o.type);
                    if (o.href) el.setAttribute("href", o.href);
                    if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
                    if (o.prepend) {
                        this.insertBefore(el, this.firstChild);
                        return el;
                    }
                }
            }
            this.appendChild(el);
            return el;
        };
    }

    // .createDiv(options?) — shorthand for createEl("div", ...)
    if (!proto.createDiv) {
        proto.createDiv = function (this: HTMLElement, o?: any) {
            return (this as any).createEl("div", o);
        };
    }

    // .createSpan(options?) — shorthand for createEl("span", ...)
    if (!proto.createSpan) {
        proto.createSpan = function (this: HTMLElement, o?: any) {
            return (this as any).createEl("span", o);
        };
    }

    // .setText(text)
    if (!proto.setText) {
        proto.setText = function (this: HTMLElement, text: string) {
            this.textContent = text;
        };
    }

    // .addClass(cls)
    if (!proto.addClass) {
        proto.addClass = function (this: HTMLElement, ...cls: string[]) {
            for (const c of cls) {
                if (c) this.classList.add(...c.split(/\s+/).filter(Boolean));
            }
        };
    }

    // .removeClass(cls)
    if (!proto.removeClass) {
        proto.removeClass = function (this: HTMLElement, ...cls: string[]) {
            for (const c of cls) {
                if (c) this.classList.remove(...c.split(/\s+/).filter(Boolean));
            }
        };
    }

    // .toggleClass(cls, value?)
    if (!proto.toggleClass) {
        proto.toggleClass = function (this: HTMLElement, cls: string, value?: boolean) {
            if (value === undefined) {
                this.classList.toggle(cls);
            } else {
                if (value) this.classList.add(cls);
                else this.classList.remove(cls);
            }
        };
    }

    // .hasClass(cls)
    if (!proto.hasClass) {
        proto.hasClass = function (this: HTMLElement, cls: string) {
            return this.classList.contains(cls);
        };
    }

    // .setAttr(key, value) / .setAttrs({k:v,...}) / .getAttr(key)
    // Obsidian HTMLElement extensions. MUST exist — without them, plugin
    // settings tabs that call `.setAttr(...)` in their `display()` hook
    // throw partway through rendering, which silently aborts the rest of
    // the settings panel (e.g. the MindZJ plugin's Keys / Scroll sections
    // never render because an About link calls setAttr before them).
    if (!proto.setAttr) {
        proto.setAttr = function (this: HTMLElement, key: string, value: string | number | boolean | null) {
            if (value === null || value === false) {
                this.removeAttribute(key);
            } else if (value === true) {
                this.setAttribute(key, "");
            } else {
                this.setAttribute(key, String(value));
            }
        };
    }
    if (!proto.setAttrs) {
        proto.setAttrs = function (this: HTMLElement, attrs: Record<string, any>) {
            for (const [k, v] of Object.entries(attrs)) {
                (this as any).setAttr(k, v);
            }
        };
    }
    if (!proto.getAttr) {
        proto.getAttr = function (this: HTMLElement, key: string) {
            return this.getAttribute(key);
        };
    }

    // .detach() — remove from parent
    if (!proto.detach) {
        proto.detach = function (this: HTMLElement) {
            this.remove();
        };
    }

    // .getText() — get text content
    if (!proto.getText) {
        proto.getText = function (this: HTMLElement) {
            return this.textContent ?? "";
        };
    }

    const globalObj = globalThis as any;
    if (!globalObj.createEl) {
        globalObj.createEl = function (tag: string, o?: any) {
            const host = document.createElement("div");
            return (host as any).createEl(tag, o);
        };
    }
    if (!globalObj.createDiv) {
        globalObj.createDiv = function (o?: any) {
            return globalObj.createEl("div", o);
        };
    }
    if (!globalObj.createSpan) {
        globalObj.createSpan = function (o?: any) {
            return globalObj.createEl("span", o);
        };
    }

    // Also patch SVGElement
    const svgProto = SVGElement.prototype as any;
    if (!svgProto.addClass) {
        svgProto.addClass = function (this: SVGElement, ...cls: string[]) {
            for (const c of cls) if (c) this.classList.add(...c.split(/\s+/).filter(Boolean));
        };
    }
    if (!svgProto.removeClass) {
        svgProto.removeClass = function (this: SVGElement, ...cls: string[]) {
            for (const c of cls) if (c) this.classList.remove(...c.split(/\s+/).filter(Boolean));
        };
    }
    if (!svgProto.toggleClass) {
        svgProto.toggleClass = function (this: SVGElement, cls: string, value?: boolean) {
            if (value === undefined) this.classList.toggle(cls);
            else { if (value) this.classList.add(cls); else this.classList.remove(cls); }
        };
    }
    if (!svgProto.setAttr) {
        svgProto.setAttr = function (this: SVGElement, key: string, value: any) {
            if (value === null || value === false) this.removeAttribute(key);
            else if (value === true) this.setAttribute(key, "");
            else this.setAttribute(key, String(value));
        };
    }
    if (!svgProto.getAttr) {
        svgProto.getAttr = function (this: SVGElement, key: string) {
            return this.getAttribute(key);
        };
    }

    // Inject Obsidian CSS variable aliases so plugin stylesheets work.
    // Obsidian uses --background-primary etc; MindZJ uses --mz-bg-primary etc.
    const aliasStyle = document.createElement("style");
    aliasStyle.setAttribute("data-obsidian-compat", "true");
    aliasStyle.textContent = `
      :root, body {
        --background-primary: var(--mz-bg-primary);
        --background-primary-alt: var(--mz-bg-secondary);
        --background-secondary: var(--mz-bg-secondary);
        --background-secondary-alt: var(--mz-bg-tertiary, var(--mz-bg-secondary));
        --background-modifier-border: var(--mz-border);
        --background-modifier-hover: var(--mz-bg-hover);
        --background-modifier-active-hover: var(--mz-bg-active);
        --background-modifier-form-field: var(--mz-bg-primary);
        --text-normal: var(--mz-text-primary);
        --text-muted: var(--mz-text-muted);
        --text-faint: var(--mz-text-muted);
        --text-on-accent: #fff;
        --text-error: var(--mz-error, #e06c75);
        --text-accent: var(--mz-accent);
        --text-accent-hover: var(--mz-accent);
        --text-highlight-bg: var(--mz-syntax-highlight-bg, rgba(229, 192, 123, 0.25));
        --interactive-normal: var(--mz-bg-secondary);
        --interactive-hover: var(--mz-bg-hover);
        --interactive-accent: var(--mz-accent);
        --interactive-accent-hover: var(--mz-accent);
        --scrollbar-bg: transparent;
        --scrollbar-thumb-bg: var(--mz-border);
        --scrollbar-active-thumb-bg: var(--mz-text-muted);
        --font-text-size: var(--mz-font-size-base, 15px);
        --font-ui-small: var(--mz-font-size-xs);
        --font-ui-medium: var(--mz-font-size-sm);
        --color-accent: var(--mz-accent);
        --color-base-00: var(--mz-bg-primary);
        --color-base-10: var(--mz-bg-secondary);
        --color-base-20: var(--mz-bg-secondary);
        --color-base-25: var(--mz-border);
        --color-base-30: var(--mz-border);
        --color-base-35: var(--mz-border-strong, var(--mz-border));
        --color-base-40: var(--mz-text-muted);
        --color-base-50: var(--mz-text-muted);
        --color-base-60: var(--mz-text-secondary);
        --color-base-70: var(--mz-text-secondary);
        --color-base-100: var(--mz-text-primary);
        --icon-color: var(--mz-text-muted);
        --icon-color-hover: var(--mz-text-primary);
        --icon-color-active: var(--mz-accent);
        --tab-text-color: var(--mz-text-secondary);
        --tab-text-color-active: var(--mz-text-primary);
        --font-text-theme-override: var(--mz-font-sans);
        --input-shadow: 0 0 0 0 transparent;
        --input-shadow-hover: 0 0 0 0 transparent;
        --pill-color: var(--mz-bg-hover);
        --pill-color-hover: var(--mz-bg-active);
        --pill-color-active: var(--mz-accent);
        --toggle-radius: 11px;
        --toggle-width: 40px;
        --toggle-thumb-color: white;
        --toggle-thumb-radius: 50%;
        --checkbox-color: var(--mz-accent);
        --checkbox-border-color: var(--mz-border);
        --checkbox-radius: 4px;
        --radius-s: 4px;
        --radius-m: 6px;
        --radius-l: 8px;
        --size-4-1: 4px;
        --size-4-2: 8px;
        --size-4-3: 12px;
        --size-4-4: 16px;
        --size-4-5: 20px;
        --size-4-6: 24px;
        --font-semibold: 600;
        --font-normal: 400;
      }

      /* ── Obsidian Plugin Settings Styles ── */
      .vertical-tab-content {
        font-size: 14px;
        line-height: 1.5;
        color: var(--mz-text-primary);
        width: 100%;
        box-sizing: border-box;
      }

      .setting-item {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 12px 0;
        border-bottom: 1px solid var(--mz-border);
        gap: 16px;
        flex-wrap: wrap;
      }
      .setting-item:last-child {
        border-bottom: none;
      }
      .setting-item-heading {
        border-bottom: none;
        padding-top: 20px;
        padding-bottom: 8px;
      }
      .setting-item-heading .setting-item-name {
        font-size: 16px;
        font-weight: 600;
        color: var(--mz-text-primary);
      }
      .setting-item-heading .setting-item-description {
        margin-top: 4px;
      }
      .setting-item-info {
        flex: 1;
        min-width: 0;
      }
      .setting-item-name {
        font-size: 14px;
        font-weight: 500;
        color: var(--mz-text-primary);
        margin-bottom: 2px;
      }
      .setting-item-description {
        font-size: 12px;
        color: var(--mz-text-muted);
        line-height: 1.5;
      }
      .setting-item-description a {
        color: var(--mz-accent);
        text-decoration: none;
      }
      .setting-item-description a:hover {
        text-decoration: underline;
      }
      .setting-item-control {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .setting-item-control input[type="text"],
      .setting-item-control input[type="number"],
      .setting-item-control input[type="password"],
      .setting-item-control input[type="search"] {
        padding: 4px 8px;
        border: 1px solid var(--mz-border);
        border-radius: 4px;
        background: var(--mz-bg-primary);
        color: var(--mz-text-primary);
        font-size: 13px;
        outline: none;
        transition: border-color 150ms;
      }
      .setting-item-control input[type="text"]:focus,
      .setting-item-control input[type="number"]:focus,
      .setting-item-control input[type="password"]:focus,
      .setting-item-control input[type="search"]:focus {
        border-color: var(--mz-accent);
      }
      .setting-item-control textarea {
        padding: 6px 8px;
        border: 1px solid var(--mz-border);
        border-radius: 4px;
        background: var(--mz-bg-primary);
        color: var(--mz-text-primary);
        font-size: 13px;
        outline: none;
        resize: vertical;
        min-height: 60px;
        transition: border-color 150ms;
      }
      .setting-item-control textarea:focus {
        border-color: var(--mz-accent);
      }
      .setting-item-control select {
        padding: 4px 8px;
        border: 1px solid var(--mz-border);
        border-radius: 4px;
        background: var(--mz-bg-primary);
        color: var(--mz-text-primary);
        font-size: 13px;
        outline: none;
        cursor: pointer;
      }
      .setting-item-control button {
        padding: 4px 12px;
        border: 1px solid var(--mz-border);
        border-radius: 4px;
        background: var(--mz-bg-secondary);
        color: var(--mz-text-primary);
        font-size: 13px;
        cursor: pointer;
        transition: border-color 150ms, background 150ms;
      }
      .setting-item-control button:hover {
        border-color: var(--mz-accent);
      }
      .setting-item-control .mod-cta,
      .setting-item-control button.mod-cta {
        background: var(--mz-accent);
        color: white;
        border-color: var(--mz-accent);
      }
      .setting-item-control .mod-warning,
      .setting-item-control button.mod-warning {
        color: var(--mz-error, #e06c75);
      }

      /* Setting group styling */
      .setting-group {
        margin-bottom: 8px;
        padding: 8px 12px;
        border: 1px solid var(--mz-border);
        border-radius: 6px;
        background: var(--mz-bg-primary);
      }
      .setting-group-heading {
        font-size: 14px;
        font-weight: 600;
        color: var(--mz-text-primary);
        margin: 4px 0 8px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--mz-border);
      }

      /* Plugin sub-settings (pixel-perfect-image, etc.) */
      .pixel-perfect-setting-hidden {
        display: none !important;
      }
      .pixel-perfect-sub-settings {
        margin-left: 16px;
        padding-left: 12px;
        border-left: 2px solid var(--mz-border);
      }
      .pixel-perfect-zoom-value {
        font-size: 12px;
        color: var(--mz-text-muted);
        min-width: 32px;
        text-align: right;
      }

      /* Modal styling for plugins */
      .modal-close-button {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: var(--mz-text-muted);
        cursor: pointer;
        border-radius: 4px;
        font-size: 18px;
      }
      .modal-close-button:hover {
        background: var(--mz-bg-hover);
        color: var(--mz-text-primary);
      }
      .modal-title {
        margin: 0 0 12px;
        font-size: 18px;
        font-weight: 600;
      }
      .mod-warning {
        color: var(--mz-error, #e06c75);
      }
    `;
    document.head.appendChild(aliasStyle);

    // Pre-register common Obsidian icon SVG paths used by plugins
    const icons: Record<string, string> = {
        reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
        copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        "external-link": '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
        info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
        plus: '<path d="M5 12h14M12 5v14"/>',
        minus: '<path d="M5 12h14"/>',
        x: '<path d="M18 6 6 18M6 6l12 12"/>',
        check: '<path d="M20 6 9 17l-5-5"/>',
        "chevron-down": '<path d="m6 9 6 6 6-6"/>',
        "chevron-right": '<path d="m9 18 6-6-6-6"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        "eye-off": '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
        folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    };
    if (!(window as any).__mindzj_icons) (window as any).__mindzj_icons = {};
    Object.assign((window as any).__mindzj_icons, icons);

    console.log("[Plugin] Obsidian DOM extensions installed");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginManifest {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
}

interface PluginInfo {
    manifest: PluginManifest;
    enabled: boolean;
    has_styles: boolean;
    dir_path: string;
}

interface LoadedPlugin {
    id: string;
    manifest: PluginManifest;
    styleEl: HTMLStyleElement | null;
    instance: any;
}

interface PluginCommand {
    id: string;
    name: string;
    callback?: () => void | Promise<void>;
    editorCallback?: (editor: any, view: any) => void | Promise<void>;
    hotkeys?: Array<{ modifiers?: string[]; key?: string }>;
    icon?: string;
    pluginId: string;
}

type CommandEntry = {
    id: string;
    name: string;
    icon?: string;
    hotkeys?: Array<{ modifiers?: string[]; key?: string }>;
    callback?: () => void | Promise<void>;
    editorCallback?: (editor: any, view: any) => void | Promise<void>;
};

const pluginDataDirMap = new Map<string, string>();
const pluginCommandRegistry = new Map<string, PluginCommand>();

function getPluginDataDir(pluginId: string): string {
    return pluginDataDirMap.get(pluginId) ?? pluginId;
}

function getCurrentEditorCompat(): any | null {
    return (window as any).__mindzj_plugin_editor_api ?? null;
}

function getCurrentMarkdownViewCompat(): any | null {
    return (window as any).__mindzj_markdown_view ?? null;
}

function escapeMarkdownCompatHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function renderMarkdownCompatInline(markdown: string): string {
    let html = escapeMarkdownCompatHtml(markdown);
    html = html.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_match, text, href) => `<a href="${String(href)}" target="_blank" rel="noopener">${text}</a>`,
    );
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
    html = html.replace(/`(.+?)`/g, "<code>$1</code>");
    return html;
}

function renderMarkdownCompat(markdown: string): string {
    const blocks = markdown.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
    if (!blocks.length) return "";

    return blocks.map((block) => {
        if (block.startsWith("### ")) {
            return `<h3>${renderMarkdownCompatInline(block.slice(4))}</h3>`;
        }
        if (block.startsWith("## ")) {
            return `<h2>${renderMarkdownCompatInline(block.slice(3))}</h2>`;
        }
        if (block.startsWith("# ")) {
            return `<h1>${renderMarkdownCompatInline(block.slice(2))}</h1>`;
        }
        if (block.startsWith("- ")) {
            const items = block.split("\n").filter((line) => line.startsWith("- "));
            return `<ul>${items.map((line) => `<li>${renderMarkdownCompatInline(line.slice(2))}</li>`).join("")}</ul>`;
        }
        return `<p>${renderMarkdownCompatInline(block).replace(/\n/g, "<br />")}</p>`;
    }).join("");
}

function getBuiltinCommands(): CommandEntry[] {
    return [
        { id: "editor:focus", name: "Focus editor", callback: () => getCurrentEditorCompat()?.focus?.() },
        { id: "editor:toggle-bold", name: "Bold", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "bold" } })) },
        { id: "editor:toggle-italics", name: "Italic", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "italic" } })) },
        { id: "editor:toggle-strikethrough", name: "Strikethrough", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "strikethrough" } })) },
        { id: "editor:toggle-underline", name: "Underline", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "underline" } })) },
        { id: "editor:toggle-highlight", name: "Highlight", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "highlight" } })) },
        { id: "editor:toggle-code", name: "Inline code", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "code" } })) },
        { id: "editor:toggle-blockquote", name: "Blockquote", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "quote" } })) },
        { id: "editor:toggle-checklist-status", name: "Checklist status", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "toggle-checklist-status" } })) },
        { id: "editor:toggle-bullet-list", name: "Bullet list", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "bullet-list" } })) },
        { id: "editor:toggle-numbered-list", name: "Numbered list", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "numbered-list" } })) },
        { id: "editor:toggle-comments", name: "Comment", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "toggle-comment" } })) },
        { id: "editor:insert-link", name: "Insert link", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "link" } })) },
        { id: "editor:insert-tag", name: "Insert tag", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "tag" } })) },
        { id: "editor:insert-wikilink", name: "Insert wikilink", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "wikilink" } })) },
        { id: "editor:insert-embed", name: "Insert embed", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "embed" } })) },
        { id: "editor:insert-callout", name: "Insert callout", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "callout" } })) },
        { id: "editor:insert-mathblock", name: "Insert math block", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "mathblock" } })) },
        { id: "editor:insert-table", name: "Insert table", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "table" } })) },
        { id: "editor:swap-line-up", name: "Swap line up", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "move-line-up" } })) },
        { id: "editor:swap-line-down", name: "Swap line down", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "move-line-down" } })) },
        { id: "editor:clear-formatting", name: "Clear formatting", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "clear-formatting" } })) },
        { id: "editor:set-heading-1", name: "Heading 1", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 1 } })) },
        { id: "editor:set-heading-2", name: "Heading 2", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 2 } })) },
        { id: "editor:set-heading-3", name: "Heading 3", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 3 } })) },
        { id: "editor:set-heading-4", name: "Heading 4", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 4 } })) },
        { id: "editor:set-heading-5", name: "Heading 5", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 5 } })) },
        { id: "editor:set-heading-6", name: "Heading 6", callback: () => document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail: { command: "heading", level: 6 } })) },
        { id: "app:toggle-left-sidebar", name: "Toggle left sidebar", callback: () => document.dispatchEvent(new CustomEvent("mindzj:app-command", { detail: { command: "toggle-left-sidebar" } })) },
        { id: "app:toggle-right-sidebar", name: "Toggle right sidebar", callback: () => document.dispatchEvent(new CustomEvent("mindzj:app-command", { detail: { command: "toggle-right-sidebar" } })) },
    ];
}

function getAllCommands(): CommandEntry[] {
    return [
        ...getBuiltinCommands(),
        ...Array.from(pluginCommandRegistry.values()).map((cmd) => ({
            id: cmd.id,
            name: cmd.name,
            icon: cmd.icon,
            hotkeys: cmd.hotkeys,
            callback: cmd.callback,
            editorCallback: cmd.editorCallback,
        })),
    ];
}

export function listPluginCommands(): Array<{ id: string; name: string }> {
    return getAllCommands().map((cmd) => ({ id: cmd.id, name: cmd.name }));
}

export async function runPluginCommand(commandId: string): Promise<boolean> {
    return executeCommandById(commandId);
}

function getCommandMap(): Record<string, CommandEntry> {
    return Object.fromEntries(getAllCommands().map((cmd) => [cmd.id, cmd]));
}

async function executeCommandById(commandId: string): Promise<boolean> {
    const command = getCommandMap()[commandId];
    if (!command) return false;

    const editor = getCurrentEditorCompat();
    const view = getCurrentMarkdownViewCompat();

    try {
        if (command.editorCallback && editor) {
            await command.editorCallback(editor, view);
            return true;
        }
        if (command.callback) {
            await command.callback();
            return true;
        }
    } catch (e) {
        console.error(`[Plugin Command] Failed to execute "${commandId}":`, e);
    }
    return false;
}

function normalizeHotkeyKey(key: string | undefined): string {
    if (!key) return "";
    const value = key.toLowerCase();
    if (value === "space") return " ";
    return value;
}

function matchesPluginHotkey(
    event: KeyboardEvent,
    hotkey: { modifiers?: string[]; key?: string } | undefined,
): boolean {
    if (!hotkey?.key) return false;
    const modifiers = new Set((hotkey.modifiers ?? []).map((m) => m.toLowerCase()));
    const expectsMod = modifiers.has("mod");
    const expectsCtrl = modifiers.has("ctrl");
    const expectsMeta = modifiers.has("meta");
    const expectsShift = modifiers.has("shift");
    const expectsAlt = modifiers.has("alt");

    const wantCtrl = expectsCtrl || (expectsMod && !("ontouchstart" in window) && navigator.platform.toLowerCase().includes("win"));
    const wantMeta = expectsMeta || (expectsMod && navigator.platform.toLowerCase().includes("mac"));

    if (!!event.ctrlKey !== wantCtrl) return false;
    if (!!event.metaKey !== wantMeta) return false;
    if (!!event.shiftKey !== expectsShift) return false;
    if (!!event.altKey !== expectsAlt) return false;

    return normalizeHotkeyKey(event.key) === normalizeHotkeyKey(hotkey.key);
}

let _pluginHotkeysInstalled = false;
function installPluginHotkeys() {
    if (_pluginHotkeysInstalled) return;
    _pluginHotkeysInstalled = true;

    document.addEventListener("keydown", (event) => {
        const commands = Array.from(pluginCommandRegistry.values());
        for (const command of commands) {
            if (!command.hotkeys?.length) continue;
            if (!command.hotkeys.some((hotkey) => matchesPluginHotkey(event, hotkey))) {
                continue;
            }
            event.preventDefault();
            event.stopPropagation();
            void executeCommandById(command.id);
            break;
        }
    }, true);
}

// ---------------------------------------------------------------------------
// Global Plugin View Registry
// ---------------------------------------------------------------------------

/** Maps viewType -> view creator function */
const pluginViewRegistry = new Map<string, (leaf: any) => any>();

/** Maps file extension (without dot) -> viewType */
const pluginExtensionMap = new Map<string, string>();

/**
 * Currently active plugin views keyed by a unique MOUNT HANDLE (not by
 * file path).
 *
 * Keying by file path made it impossible to mount the same file in two
 * panes of the same window — the second mount would overwrite the first
 * entry and orphan the first view's DOM. With a per-mount handle, each
 * `PluginViewHost` instance owns its own entry, so a user can split a
 * `.mindzj` tab left/right/up/down and see the same file in both panes
 * side-by-side.
 *
 * The handle is purely opaque: callers get it back from `mountPluginView`
 * and pass it to `destroyPluginView` on unmount. Anything that needs
 * "the view for this file path" (e.g. Outline) iterates values and
 * matches by `view.file?.path`.
 */
const activePluginViews = new Map<string, any>();

/** Monotonic counter for generating unique mount handles. */
let _pluginMountCounter = 0;

/** Paths currently being saved by a plugin — used to suppress file-watcher reloads */
const _pluginSavingPaths = new Set<string>();

/** Normalize path separators for reliable comparison on Windows */
function _normPath(p: string): string {
    return p.replace(/\\/g, "/");
}

/**
 * Check if a file is currently being saved by a plugin.
 * When true, the file-watcher should NOT reload the file because that would
 * reset in-memory plugin state (e.g., node selection after Tab key).
 */
export function isPluginSaving(path: string): boolean {
    return _pluginSavingPaths.has(_normPath(path));
}

/** Plugin setting tabs keyed by plugin id */
const pluginSettingTabs = new Map<string, any>();

/**
 * Get the setting tab for a plugin by its id.
 */
export function getPluginSettingTab(pluginId: string): any | null {
    return pluginSettingTabs.get(pluginId) ?? null;
}

/**
 * Reactive counter — bumped every time plugins finish loading.
 * Any UI that depends on plugin registrations should read this signal
 * to re-evaluate when new plugins become available.
 */
const [pluginsVersion, setPluginsVersion] = createSignal(0);
export { pluginsVersion };

/**
 * Check if a file extension has a registered plugin view.
 */
export function hasPluginViewForExtension(ext: string): boolean {
    // Reading pluginsVersion makes this reactive — callers will
    // re-evaluate when plugins finish loading.
    pluginsVersion();
    return pluginExtensionMap.has(ext);
}

/**
 * Create and mount a plugin view for a file.
 *
 * Returns an object with the view instance and an opaque `handle` that
 * the caller MUST pass back to `destroyPluginView` on unmount. Each
 * call creates a brand-new handle so the same file can be mounted in
 * multiple panes of the same window without the views clobbering each
 * other.
 *
 * The caller is responsible for cleanup — this function does NOT
 * destroy any existing view for the same file path. That's a
 * deliberate change from the previous behaviour: when you split a
 * plugin-backed tab into two panes, the original pane's view must
 * survive the second mount.
 *
 * Returns `null` if no plugin is registered for this extension.
 */
export async function mountPluginView(
    ext: string,
    filePath: string,
    content: string,
    mountEl: HTMLElement,
): Promise<{ view: any; handle: string } | null> {
    const viewType = pluginExtensionMap.get(ext);
    if (!viewType) return null;

    const viewCreator = pluginViewRegistry.get(viewType);
    if (!viewCreator) return null;

    // Create app object for the view
    const app = createAppObject("plugin-view");

    // Create a leaf-like object that the plugin view receives.
    // The view's constructor (super(leaf)) will set this.leaf = leaf, this.app = leaf.app
    const leaf: any = {
        app,
        view: null as any,
        containerEl: null as any, // Will be set after view creation
        getViewState: () => ({ type: viewType, state: { file: filePath } }),
        setViewState: async () => {},
        detach: () => {},
        getDisplayText: () => filePath.split("/").pop() ?? filePath,
        getEphemeralState: () => ({}),
        setEphemeralState: () => {},
        togglePinned: () => {},
        setPinned: () => {},
        setGroup: () => {},
        setGroupMember: () => {},
        openFile: async (file: any) => {
            const path = typeof file === "string" ? file : file?.path;
            if (path) await vaultStore.openFile(path);
        },
    };

    try {
        // The view creator calls `new MindMapView(leaf, pluginInstance)`.
        // MindMapView's constructor calls `super(leaf)` which is TextFileView(leaf) -> ItemView(leaf).
        // Our ItemView constructor creates containerEl with [headerEl, contentEl] structure.
        const view = viewCreator(leaf);
        leaf.view = view;
        leaf.containerEl = view.containerEl;

        // Set the file reference (TFile-like)
        const fileName = filePath.split("/").pop() ?? filePath;
        const baseName = fileName.replace(/\.[^.]+$/, "");
        view.file = {
            path: filePath,
            name: fileName,
            basename: baseName,
            extension: ext,
            stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
            vault: { getName: () => vaultStore.vaultInfo()?.name ?? "vault" },
            parent: { path: filePath.split("/").slice(0, -1).join("/") || "/", name: filePath.split("/").slice(-2, -1)[0] || "/" },
        };

        // Ensure app is available on the view
        if (!view.app) view.app = app;

        // Wire up requestSave to actually persist changes.
        // Use _pluginSaving flag to prevent the file watcher from re-loading the file
        // and resetting plugin state (e.g., node selection after Tab key).
        // Track save-in-progress count to handle rapid consecutive saves
        let _saveCounter = 0;
        const _normFilePath = _normPath(filePath);
        view.requestSave = async () => {
            try {
                const data = view.getViewData();
                if (data !== undefined && data !== null) {
                    _pluginSavingPaths.add(_normFilePath);
                    _saveCounter++;
                    const myCount = _saveCounter;
                    await vaultStore.saveFile(filePath, data);
                    // Only clear the flag if no newer save has started
                    setTimeout(() => {
                        if (_saveCounter === myCount) {
                            _pluginSavingPaths.delete(_normFilePath);
                        }
                    }, 1500);
                }
                // Notify the Outline component to refresh its tree view
                document.dispatchEvent(new CustomEvent("mindzj:outline-refresh"));
            } catch (e) {
                console.error("[Plugin View] requestSave error:", e);
            }
        };

        // Mount the view's containerEl into the mountEl.
        // Don't overwrite containerEl — the view's onOpen() uses containerEl.children[1] (contentEl).
        // Use flex:1 so it fills the parent flex container properly.
        Object.assign(view.containerEl.style, {
            width: "100%",
            flex: "1",
            minHeight: "0",
            position: "relative",
        });
        mountEl.appendChild(view.containerEl);

        // Register the view BEFORE lifecycle calls so that isAct() / getActiveViewOfType
        // work during onOpen() and setViewData() — the plugin's keyboard handler and
        // other guards check isAct() which queries activePluginViews.
        const handle = `${filePath}::${++_pluginMountCounter}`;
        activePluginViews.set(handle, view);

        // Set this leaf as the active leaf so workspace.activeLeaf is correct
        if (app.workspace) {
            app.workspace.activeLeaf = leaf;
        }

        // Lifecycle: onOpen then setViewData
        if (typeof view.onOpen === "function") {
            await view.onOpen();
        }
        if (typeof view.setViewData === "function") {
            await view.setViewData(content, true);
        }

        console.log(`[Plugin View] Mounted view for ${filePath} (handle: ${handle}, type: ${viewType})`);
        return { view, handle };
    } catch (e) {
        console.error("[Plugin View] Failed to create view:", e);
        return null;
    }
}

/**
 * Destroy the plugin view for the given mount HANDLE (the opaque
 * string returned by `mountPluginView`). Each `PluginViewHost` stores
 * its own handle and calls this on unmount, which keeps sibling panes
 * showing the same file untouched.
 */
export function destroyPluginView(handle: string) {
    const view = activePluginViews.get(handle);
    if (view) {
        try {
            if (typeof view.onClose === "function") view.onClose();
        } catch (e) {
            console.warn("[Plugin View] onClose error:", e);
        }
        // Remove DOM
        try {
            if (view.containerEl?.parentElement) {
                view.containerEl.remove();
            }
        } catch {}
        activePluginViews.delete(handle);
    }
}

/**
 * Get the active plugin view for a file path. If the same file is
 * mounted in multiple panes, returns the first one found. Used by
 * Outline etc. that just need "some view for this file".
 */
export function getActivePluginView(filePath: string): any | null {
    for (const view of activePluginViews.values()) {
        if (view?.file?.path === filePath) return view;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Workspace Event Bridges
// ---------------------------------------------------------------------------

let _workspaceBridgesInstalled = false;
function installWorkspaceBridges() {
    if (_workspaceBridgesInstalled) return;
    _workspaceBridgesInstalled = true;

    // Bridge window resize to workspace "resize" event
    window.addEventListener("resize", () => {
        document.dispatchEvent(new CustomEvent("mindzj:workspace-trigger", {
            detail: { event: "resize" },
        }));
    });
}

// ---------------------------------------------------------------------------
// Plugin Store
// ---------------------------------------------------------------------------

function createPluginStore() {
    const [loadedPlugins, setLoadedPlugins] = createSignal<LoadedPlugin[]>([]);
    const [loading, setLoading] = createSignal(false);

    async function loadAllPlugins(): Promise<void> {
        // Install Obsidian DOM extensions before any plugin code runs
        installObsidianDomExtensions();
        installPluginHotkeys();
        installWorkspaceBridges();
        await unloadAllPlugins();
        setLoading(true);
        try {
            const plugins = await invoke<PluginInfo[]>("list_plugins");
            const enabled = plugins.filter(p => p.enabled);
            for (const plugin of enabled) {
                try {
                    await loadPlugin(plugin);
                } catch (e) {
                    console.error(`[Plugin] Failed to load "${plugin.manifest.name}":`, e);
                }
            }
        } catch (e) {
            console.error("[Plugin] Failed to list plugins:", e);
        } finally {
            setLoading(false);
            // Bump reactive version so UI re-evaluates hasPluginViewForExtension
            setPluginsVersion(v => v + 1);
            // Notify plugins that loading is complete — fire layout-change,
            // layout-ready, and active-leaf-change so plugins can initialize
            // their UI (e.g. pixel-perfect-image attaches to images).
            setTimeout(() => {
                for (const evt of ["layout-ready", "layout-change", "active-leaf-change", "file-open"]) {
                    document.dispatchEvent(new CustomEvent("mindzj:workspace-trigger", {
                        detail: { event: evt },
                    }));
                }
            }, 200);
        }
    }

    async function loadPlugin(plugin: PluginInfo): Promise<void> {
        const id = plugin.manifest.id;
        let styleEl: HTMLStyleElement | null = null;
        let instance: any = null;
        const dirName = plugin.dir_path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? id;
        pluginDataDirMap.set(id, dirName);

        // 1. Inject CSS
        if (plugin.has_styles) {
            try {
                const css = await invoke<string>("read_plugin_styles", { pluginId: id });
                if (css) {
                    styleEl = document.createElement("style");
                    styleEl.setAttribute("data-plugin-id", id);
                    styleEl.textContent = css;
                    document.head.appendChild(styleEl);
                }
            } catch (e) {
                console.warn(`[Plugin] CSS load failed for "${id}":`, e);
            }
        }

        // 2. Execute main.js
        try {
            const jsCode = await invoke<string>("read_plugin_main", { pluginId: id });
            if (jsCode) {
                instance = await executePluginCode(id, jsCode, plugin.manifest);
            }
        } catch (e) {
            console.warn(`[Plugin] JS load failed for "${id}":`, e);
        }

        setLoadedPlugins(prev => {
            const next = [...prev, { id, manifest: plugin.manifest, styleEl, instance }];
            // Expose for Outline component to find plugins with outline creators
            (window as any).__mindzj_loadedPlugins = next;
            return next;
        });
        console.log(`[Plugin] Loaded: ${plugin.manifest.name} v${plugin.manifest.version}`);
    }

    async function executePluginCode(pluginId: string, code: string, manifest: PluginManifest): Promise<any> {
        // Build the Obsidian compatibility shim
        const obsidianModule = createObsidianShim(pluginId);

        const minimalRequire = (name: string) => {
            if (name === "obsidian") return obsidianModule;
            // Provide minimal Node.js module shims used by some plugins
            if (name === "path") {
                return {
                    join: (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
                    basename: (p: string) => p.split(/[\\/]/).pop() ?? p,
                    dirname: (p: string) => { const parts = p.split(/[\\/]/); parts.pop(); return parts.join("/") || "."; },
                    extname: (p: string) => { const m = p.match(/\.[^.]+$/); return m ? m[0] : ""; },
                    resolve: (...parts: string[]) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
                    sep: "/",
                };
            }
            if (name === "child_process") {
                return {
                    spawn: () => {
                        const noop = () => {};
                        return { on: noop, unref: noop, stdout: null, stderr: null, pid: 0 };
                    },
                    exec: (_cmd: string, cb?: Function) => { if (cb) cb(new Error("child_process not available")); },
                };
            }
            console.warn(`[Plugin:${pluginId}] require("${name}") — not available`);
            return {};
        };

        try {
            const moduleObj = { exports: {} as any };
            const factory = new Function("module", "exports", "require", code);
            factory(moduleObj, moduleObj.exports, minimalRequire);

            const exported = moduleObj.exports;
            const PluginClass = exported?.default || exported;

            if (typeof PluginClass === "function") {
                // Create the app object the plugin receives
                const app = createAppObject(pluginId, obsidianModule);

                // Instantiate — Obsidian plugins receive (app, manifest) in constructor
                const instance = new PluginClass(app, manifest);
                instance.app = app;
                instance.manifest = manifest;

                if (typeof instance.onload === "function") {
                    try {
                        await instance.onload();
                    } catch (loadErr) {
                        console.error(`[Plugin:${pluginId}] onload() threw:`, loadErr);
                        // Still return the instance — the settings tab may
                        // have been registered before the error occurred.
                    }
                }
                return instance;
            }
        } catch (e) {
            console.error(`[Plugin:${pluginId}] Execution error:`, e);
        }
        return null;
    }

    async function unloadAllPlugins(): Promise<void> {
        for (const p of loadedPlugins()) {
            try { if (p.instance?.onunload) await p.instance.onunload(); } catch (e) { console.warn(`[Plugin] Unload error "${p.id}":`, e); }
            if (p.styleEl) p.styleEl.remove();
            pluginDataDirMap.delete(p.id);
            pluginCommandRegistry.forEach((command, id) => {
                if (command.pluginId === p.id) pluginCommandRegistry.delete(id);
            });
        }
        setLoadedPlugins([]);
        // Clean up registries
        pluginViewRegistry.clear();
        pluginExtensionMap.clear();
        pluginSettingTabs.clear();
        // Entries are keyed by mount handle now, not file path, but the
        // destroy-all loop body is identical — we just need to close and
        // drop every entry regardless of what the key is.
        for (const [handle, view] of activePluginViews.entries()) {
            try { if (view.onClose) view.onClose(); } catch {}
            activePluginViews.delete(handle);
        }
    }

    async function unloadPlugin(pluginId: string): Promise<void> {
        const plugin = loadedPlugins().find(p => p.id === pluginId);
        if (!plugin) return;
        try { if (plugin.instance?.onunload) await plugin.instance.onunload(); } catch {}
        if (plugin.styleEl) plugin.styleEl.remove();
        pluginDataDirMap.delete(pluginId);
        pluginSettingTabs.delete(pluginId);
        pluginCommandRegistry.forEach((command, id) => {
            if (command.pluginId === pluginId) pluginCommandRegistry.delete(id);
        });
        setLoadedPlugins(prev => prev.filter(p => p.id !== pluginId));
    }

    async function reloadPlugin(pluginId: string): Promise<void> {
        await unloadPlugin(pluginId);
        try {
            const plugins = await invoke<PluginInfo[]>("list_plugins");
            const plugin = plugins.find(p => p.manifest.id === pluginId && p.enabled);
            if (plugin) await loadPlugin(plugin);
        } catch (e) {
            console.error(`[Plugin] Reload failed "${pluginId}":`, e);
        }
        // Bump reactive version so settings UI re-evaluates
        setPluginsVersion(v => v + 1);
    }

    return {
        loadedPlugins,
        loading,
        loadAllPlugins,
        unloadAllPlugins,
        unloadPlugin,
        reloadPlugin,
        // Exposed so App.tsx's hotkey handler can run plugin-registered
        // commands directly (see `handleGlobalKeydown` for Alt+F /
        // Alt+A). Calling `executeCommandById` here bypasses the per-
        // plugin `mindzj:plugin-command` DOM event the timestamp
        // plugin used to listen for — that route was firing the
        // command multiple times when the plugin's instance landed
        // on the document with more than one listener attached,
        // yielding the "4 timestamps per Alt+F" bug.
        executeCommandById,
    };
}

// ---------------------------------------------------------------------------
// Obsidian App Object — the `this.app` plugins access
// ---------------------------------------------------------------------------

/** Create a fake Obsidian WorkspaceLeaf for workspace.getLeaf() etc. */
function createFakeLeaf(app: any) {
    const leaf: any = {
        app,
        view: null,
        containerEl: document.createElement("div"),
        setViewState: async () => {},
        getViewState: () => ({}),
        reveal: () => {},
        detach: () => {},
        openFile: async (file: any) => {
            const path = typeof file === "string" ? file : file?.path;
            if (path) await vaultStore.openFile(path);
        },
    };
    return leaf;
}

function createTFileLike(path: string) {
    const normalized = path.replace(/\\/g, "/");
    const name = normalized.split("/").pop() ?? normalized;
    const basename = name.replace(/\.[^.]+$/, "");
    const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
    const parentPath = normalized.includes("/") ? normalized.split("/").slice(0, -1).join("/") : "";
    return {
        path: normalized,
        name,
        basename,
        extension,
        hash: "",
        parent: { path: parentPath, name: parentPath.split("/").pop() ?? "/" },
        stat: { mtime: Date.now(), ctime: Date.now(), size: 0 },
        vault: { getName: () => vaultStore.vaultInfo()?.name ?? "vault" },
    };
}

function findFileInTree(link: string): any | null {
    const normalizedLink = link.replace(/\\/g, "/").replace(/^\/+/, "");
    const entries = [...vaultStore.fileTree()];
    while (entries.length > 0) {
        const entry = entries.shift()!;
        if (entry.is_dir) {
            if (entry.children) entries.push(...entry.children);
            continue;
        }
        if (
            entry.relative_path === normalizedLink ||
            entry.name === normalizedLink ||
            entry.relative_path.endsWith(`/${normalizedLink}`)
        ) {
            return createTFileLike(entry.relative_path);
        }
    }
    return null;
}

function createAppObject(pluginId: string, obsidianModule?: any) {
    const FileSystemAdapterClass = obsidianModule?.FileSystemAdapter ?? class {
        getBasePath() { return vaultStore.vaultInfo()?.path ?? ""; }
    };
    const adapter = new FileSystemAdapterClass(vaultStore.vaultInfo()?.path ?? "");
    let markdownLeafCache: any = null;
    let markdownLeafSource: any = null;

    adapter.read = async (path: string) => {
        const r = await invoke<{ content: string }>("read_file", { relativePath: path });
        return r.content;
    };
    adapter.readBinary = async (path: string) => {
        const base64 = await invoke<string>("read_binary_file", { relativePath: path });
        const binary = atob(base64);
        return Uint8Array.from(binary, (char: string) => char.charCodeAt(0)).buffer;
    };
    adapter.writeBinary = async (path: string, data: ArrayBuffer) => {
        const bytes = new Uint8Array(data);
        let binaryStr = "";
        for (let i = 0; i < bytes.length; i++) binaryStr += String.fromCharCode(bytes[i]);
        const base64Data = btoa(binaryStr);
        await invoke("write_binary_file", { relativePath: path, base64Data });
    };
    adapter.write = async (path: string, data: string) => {
        await invoke("write_file", { relativePath: path, content: data });
    };
    adapter.exists = async (path: string) => {
        try {
            await invoke("read_file", { relativePath: path });
            return true;
        } catch {
            return false;
        }
    };
    adapter.remove = async (path: string) => {
        await invoke("delete_file", { relativePath: path });
    };
    adapter.rename = async (from: string, to: string) => {
        await invoke("rename_file", { from, to });
    };
    adapter.mkdir = async (path: string) => {
        await invoke("create_dir", { relativePath: path });
    };
    adapter.getBasePath = () => vaultStore.vaultInfo()?.path ?? "";
    adapter.getResourcePath = (path: string) => {
        return toVaultAssetUrl(vaultStore.vaultInfo()?.path ?? "", path);
    };
    adapter.stat = async (path: string) => {
        try {
            const meta = await invoke<any>("get_file_metadata", { relativePath: path });
            return { type: meta.is_markdown ? "file" : "file", mtime: Date.now(), ctime: Date.now(), size: meta.size || 0 };
        } catch { return null; }
    };
    adapter.list = async (path: string) => {
        try {
            const entries = await invoke<any[]>("list_entries", { relativeDir: path });
            return {
                files: entries.filter((e: any) => !e.is_dir).map((e: any) => e.relative_path),
                folders: entries.filter((e: any) => e.is_dir).map((e: any) => e.relative_path),
            };
        } catch { return { files: [], folders: [] }; }
    };

    const getMarkdownLeafCompat = () => {
        const source = getCurrentMarkdownViewCompat();
        if (!source) {
            markdownLeafCache = null;
            markdownLeafSource = null;
            return null;
        }

        if (!markdownLeafCache || markdownLeafSource !== source) {
            const leaf: any = {
                app,
                view: null,
                containerEl: source.containerEl ?? source.contentEl ?? document.body,
                getViewState: () => ({
                    type: "markdown",
                    state: { file: source.file?.path ?? vaultStore.activeFile()?.path ?? "" },
                }),
                setViewState: async () => {},
                reveal: () => {},
                detach: () => {},
                openFile: async (file: any) => {
                    const path = typeof file === "string" ? file : file?.path;
                    if (path) await vaultStore.openFile(path);
                },
            };
            const view = obsidianModule?.MarkdownView ? new obsidianModule.MarkdownView(leaf) : { ...source, leaf };
            leaf.view = view;
            markdownLeafCache = leaf;
            markdownLeafSource = source;
        }

        const active = vaultStore.activeFile();
        const fileName = active?.path.split("/").pop() ?? active?.path ?? "";
        const fallbackFile = active?.path ? {
            path: active.path,
            name: fileName,
            basename: fileName.replace(/\.[^.]+$/, ""),
            extension: fileName.includes(".") ? fileName.split(".").pop() ?? "" : "",
            stat: { mtime: Date.now(), ctime: Date.now(), size: active.content?.length ?? 0 },
            vault: { getName: () => vaultStore.vaultInfo()?.name ?? "vault" },
            parent: {
                path: active.path.includes("/") ? active.path.split("/").slice(0, -1).join("/") : "",
                name: active.path.includes("/") ? active.path.split("/").slice(-2, -1)[0] || "/" : "/",
            },
        } : null;
        const view = markdownLeafCache.view;
        view.app = app;
        view.editor = source.editor ?? null;
        view.editMode = source.editMode;
        view.currentMode = source.currentMode;
        view.sourceMode = source.sourceMode;
        view.containerEl = source.containerEl ?? source.contentEl ?? view.containerEl ?? document.body;
        view.contentEl = source.contentEl ?? source.containerEl ?? view.contentEl ?? view.containerEl;
        view.file = source.file ?? fallbackFile;
        view.getViewType = () => "markdown";
        view.getMode = () => source.getMode?.() ?? "preview";
        markdownLeafCache.app = app;
        markdownLeafCache.containerEl = view.containerEl;
        markdownLeafCache.view = view;
        return markdownLeafCache;
    };

    const app: any = {
        commands: {
            get commands() {
                return getCommandMap();
            },
            listCommands() {
                return getAllCommands().map((cmd) => ({
                    id: cmd.id,
                    name: cmd.name,
                    icon: cmd.icon,
                    hotkeys: cmd.hotkeys,
                    callback: cmd.callback,
                    editorCallback: cmd.editorCallback,
                }));
            },
            async executeCommandById(id: string) {
                return executeCommandById(id);
            },
        },
        vault: {
            adapter,
            async read(file: any) {
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return "";
                const r = await invoke<{ content: string }>("read_file", { relativePath: path });
                return r.content;
            },
            async cachedRead(file: any) {
                // Same as read() — no separate cache in MindZJ
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return "";
                const r = await invoke<{ content: string }>("read_file", { relativePath: path });
                return r.content;
            },
            async readBinary(file: any) {
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return new Uint8Array();
                const base64 = await invoke<string>("read_binary_file", { relativePath: path });
                const binary = atob(base64);
                return Uint8Array.from(binary, (char) => char.charCodeAt(0));
            },
            async modify(file: any, data: string) {
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return;
                await invoke("write_file", { relativePath: path, content: data });
            },
            async process(file: any, fn: (content: string) => string) {
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return;
                const current = await invoke<{ content: string }>("read_file", { relativePath: path });
                const nextContent = fn(current.content);
                _pluginSavingPaths.add(_normPath(path));
                try {
                    await invoke("write_file", { relativePath: path, content: nextContent });
                } finally {
                    setTimeout(() => _pluginSavingPaths.delete(_normPath(path)), 1200);
                }
            },
            async create(path: string, data: string) {
                await invoke("create_file", { relativePath: path, content: data ?? "" });
                return createTFileLike(path);
            },
            async delete(file: any) {
                const path = typeof file === "string" ? file : file?.path;
                if (!path) return;
                await invoke("delete_file", { relativePath: path });
            },
            getAbstractFileByPath(path: string) {
                return findFileInTree(path) ?? createTFileLike(path);
            },
            getFileByPath(path: string) {
                const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
                const found = findFileInTree(path);
                if (found) return found;
                if (normalized.includes(".mindzj/")) return createTFileLike(normalized);
                // Bare filename with extension → try .mindzj/images/
                if (!normalized.includes("/") && /\.\w+$/.test(normalized)) {
                    return createTFileLike(`.mindzj/images/${normalized}`);
                }
                return null;
            },
            getRoot() {
                return { path: "/", name: "/", children: [] };
            },
            getName() {
                return vaultStore.vaultInfo()?.name ?? "vault";
            },
            getConfig(_key: string) { return null; },
            /** Return all files in the vault as TFile-like objects. */
            getFiles() {
                const result: any[] = [];
                const walk = (entries: any[]) => {
                    for (const e of entries) {
                        if (e.is_dir) {
                            if (e.children) walk(e.children);
                        } else {
                            result.push(createTFileLike(e.relative_path));
                        }
                    }
                };
                walk(vaultStore.fileTree());
                return result;
            },
            /** Return all markdown files. */
            getMarkdownFiles() {
                return this.getFiles().filter((f: any) =>
                    f.extension === "md" || f.extension === "markdown",
                );
            },
            getAllLoadedFiles() {
                return this.getFiles();
            },
            _eventHandlers: {} as Record<string, Function[]>,
            on(event: string, cb: Function) {
                if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
                this._eventHandlers[event].push(cb);
                return { id: Math.random(), event, cb };
            },
            off(event: string, ref: any) {
                if (this._eventHandlers[event]) {
                    this._eventHandlers[event] = this._eventHandlers[event].filter((fn: Function) => fn !== ref?.cb);
                }
            },
            trigger(event: string, ...args: any[]) {
                for (const fn of (this._eventHandlers[event] || [])) {
                    try { fn(...args); } catch {}
                }
            },
        },
        workspace: {
            _activeLeaf: null,
            _outlineLeaves: [] as any[],
            _eventHandlers: {} as Record<string, Function[]>,
            _domListeners: [] as Array<{ handler: EventListener }>,
            rootSplit: { containerEl: document.body, children: [] as any[] },
            floatingSplit: { children: [] as any[] },
            leftSplit: { collapsed: false },
            rightSplit: { collapsed: false },
            containerEl: document.body,
            leftRibbon: { show() {}, hide() {} },
            get activeLeaf() {
                return this._activeLeaf ?? getMarkdownLeafCompat();
            },
            set activeLeaf(value: any) {
                this._activeLeaf = value;
            },
            get activeEditor() {
                const editor = getCurrentEditorCompat();
                return editor ? { editor } : null;
            },
            on(event: string, cb: Function) {
                if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
                this._eventHandlers[event].push(cb);

                // Bridge document-level workspace triggers to plugin handlers.
                // Editor.tsx dispatches "mindzj:workspace-trigger" with event
                // names like "active-leaf-change" and "layout-change".
                const handler = ((e: CustomEvent) => {
                    if (e.detail?.event === event) {
                        try {
                            if (event === "active-leaf-change") {
                                // Obsidian passes the new leaf as argument
                                cb(getMarkdownLeafCompat());
                            } else if (event === "file-open") {
                                // Obsidian passes the active TFile
                                const activeFile = vaultStore.activeFile();
                                cb(activeFile ? createTFileLike(activeFile.path) : null);
                            } else if (event === "resize" || event === "layout-change" || event === "layout-ready") {
                                cb();
                            } else {
                                cb();
                            }
                        } catch {}
                    }
                }) as EventListener;
                document.addEventListener("mindzj:workspace-trigger", handler);
                this._domListeners.push({ handler });

                return { id: Math.random(), event, cb, _handler: handler };
            },
            off(event: string, ref: any) {
                if (this._eventHandlers[event]) {
                    this._eventHandlers[event] = this._eventHandlers[event].filter((fn: Function) => fn !== ref?.cb);
                }
                if (ref?._handler) {
                    document.removeEventListener("mindzj:workspace-trigger", ref._handler);
                }
            },
            trigger(event: string, ...args: any[]) {
                const handlers = this._eventHandlers[event] || [];
                for (const fn of handlers) {
                    try { fn(...args); } catch {}
                }
            },
            getActiveViewOfType(type: any) {
                const markdownLeaf = getMarkdownLeafCompat();
                if (type === obsidianModule?.MarkdownView || type === obsidianModule?.ItemView) {
                    return markdownLeaf?.view ?? null;
                }
                if (type?.prototype?.getViewType) {
                    try {
                        const expectedType = type.prototype.getViewType();
                        if (expectedType === "markdown") {
                            return markdownLeaf?.view ?? null;
                        }
                        if (expectedType) {
                            for (const view of activePluginViews.values()) {
                                if (view.getViewType && view.getViewType() === expectedType) return view;
                            }
                        }
                    } catch {}
                }
                for (const view of activePluginViews.values()) {
                    if (type && view instanceof type) return view;
                }
                return null;
            },
            getLeavesOfType(type: string) {
                const leaves: any[] = [];
                const markdownLeaf = getMarkdownLeafCompat();
                if (type === "markdown" && markdownLeaf) {
                    leaves.push(markdownLeaf);
                }
                for (const view of activePluginViews.values()) {
                    if (view.getViewType && view.getViewType() === type) {
                        leaves.push(view.leaf || { view });
                    }
                }
                if (this._outlineLeaves) {
                    for (const leaf of this._outlineLeaves) {
                        if (leaf.view?.getViewType && leaf.view.getViewType() === type) {
                            leaves.push(leaf);
                        }
                    }
                }
                return leaves;
            },
            setActiveLeaf(leaf: any, _opts?: any) {
                this._activeLeaf = leaf;
            },
            getRightLeaf(_create: boolean) {
                return createFakeLeaf(app);
            },
            getLeftLeaf(_create: boolean) {
                return createFakeLeaf(app);
            },
            getLeaf(_newLeaf?: any, _direction?: any) {
                return createFakeLeaf(app);
            },
            async openLinkText(path: string) {
                const file = findFileInTree(path);
                if (file?.path) {
                    await vaultStore.openFile(file.path);
                    return file;
                }
                return null;
            },
            detachLeavesOfType(_type: string) {},
            revealLeaf(_leaf: any) {},
            iterateAllLeaves(cb: Function) {
                const markdownLeaf = getMarkdownLeafCompat();
                if (markdownLeaf) cb(markdownLeaf);
                for (const view of activePluginViews.values()) {
                    if (view.leaf) cb(view.leaf);
                }
            },
            onLayoutReady(cb: Function) { setTimeout(cb, 100); },
            getActiveFile() {
                const active = vaultStore.activeFile();
                if (!active) return null;
                return createTFileLike(active.path);
            },
        },
        setting: {
            get activeTab() {
                return (window as any).__mindzj_plugin_settings_active_tab ?? null;
            },
            open() {
                document.dispatchEvent(new CustomEvent("mindzj:open-settings"));
            },
            openTabById(id: string) {
                document.dispatchEvent(new CustomEvent("mindzj:open-settings", {
                    detail: { pluginId: id },
                }));
            },
        },
        metadataCache: {
            getFileCache(file: any) {
                const active = vaultStore.activeFile();
                const filePath = typeof file === "string" ? file : file?.path;
                if (!active || !filePath || active.path !== filePath) return null;
                const content = active.content;
                if (!content) return null;
                const headings: any[] = [];
                let inCodeBlock = false;
                content.split("\n").forEach((line: string, idx: number) => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith("```")) { inCodeBlock = !inCodeBlock; return; }
                    if (inCodeBlock) return;
                    const m = trimmed.match(/^(#{1,6})\s+(.+)$/);
                    if (m) {
                        headings.push({
                            heading: m[2].replace(/[#*`\[\]]/g, "").trim(),
                            level: m[1].length,
                            position: { start: { line: idx, col: 0, offset: 0 }, end: { line: idx, col: line.length, offset: 0 } },
                        });
                    }
                });
                return headings.length ? { headings } : null;
            },
            getFirstLinkpathDest(link: string, _sourcePath: string) {
                const normalized = link.replace(/\\/g, "/").replace(/^\/+/, "");
                // 1. Try direct match in the visible file tree
                const found = findFileInTree(link);
                if (found) return found;
                // 2. If link already contains .mindzj/ path, create a TFile directly
                if (normalized.includes(".mindzj/")) return createTFileLike(normalized);
                // 3. For bare filenames (e.g. "image.png"), check .mindzj/images/
                //    because the default attachment folder is excluded from the file tree
                if (!normalized.includes("/") && /\.\w+$/.test(normalized)) {
                    return createTFileLike(`.mindzj/images/${normalized}`);
                }
                return null;
            },
            on(_event: string, _cb: Function) { return { id: Math.random() }; },
            off(_event: string, _ref: any) {},
            resolvedLinks: {},
            unresolvedLinks: {},
        },
        fileManager: {
            getNewFileParent(sourcePath: string) {
                const path = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1).join("/") : "";
                return { path };
            },
            createNewMarkdownFile(folder: any, name: string) {
                const path = folder?.path ? `${folder.path}/${name}.md` : `${name}.md`;
                return invoke("create_file", { relativePath: path, content: "" }).then(() => createTFileLike(path));
            },
            renameFile(file: any, newPath: string) {
                return invoke("rename_file", { from: file.path, to: newPath });
            },
            trashFile(file: any) {
                return invoke("delete_file", { relativePath: file.path });
            },
        },
        showInFolder(relativePath: string) {
            const cleanPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
            return invoke("reveal_in_file_manager", { relativePath: cleanPath });
        },
        openWithDefaultApp(relativePath: string) {
            const cleanPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
            return invoke("open_in_default_app", { relativePath: cleanPath });
        },
        loadLocalStorage(key: string) {
            return (
                localStorage.getItem(getScopedPluginLocalStorageKey(pluginId, key)) ??
                localStorage.getItem(`mindzj-plugin-${pluginId}-${key}`)
            );
        },
        saveLocalStorage(key: string, value: string) {
            localStorage.setItem(getScopedPluginLocalStorageKey(pluginId, key), value);
        },
        // ── Obsidian-compat: app.plugins ──
        // editing-toolbar reads app.plugins.enabledPlugins to check
        // which plugins are loaded alongside it.
        plugins: {
            get enabledPlugins() {
                const ids = new Set<string>();
                for (const p of (window as any).__mindzj_loadedPlugins ?? []) {
                    ids.add(p.id);
                }
                return ids;
            },
            getPlugin(id: string) {
                const loaded = ((window as any).__mindzj_loadedPlugins ?? []) as LoadedPlugin[];
                const found = loaded.find(p => p.id === id);
                return found?.instance ?? null;
            },
            plugins: {} as Record<string, any>,
        },
        // ── Obsidian-compat: app.classList ──
        // editing-toolbar uses app.classList.add/remove/contains to toggle
        // CSS classes on the app root (Obsidian puts them on document.body).
        classList: document.body.classList,
        // ── Obsidian-compat: app.visible ──
        visible: true,
        // ── Obsidian-compat: app.isMobile ──
        isMobile: false,
    };
    return app;
}

// ---------------------------------------------------------------------------
// Obsidian Module Shim — what require("obsidian") returns
// ---------------------------------------------------------------------------

function createObsidianShim(pluginId: string) {
    // Notice — toast notification
    class Notice {
        noticeEl: HTMLElement;
        constructor(message: string | DocumentFragment, timeout?: number) {
            const text = typeof message === "string" ? message : message.textContent ?? "";
            this.noticeEl = document.createElement("div");
            this.noticeEl.textContent = text;
            Object.assign(this.noticeEl.style, {
                position: "fixed", bottom: "40px", left: "50%", transform: "translateX(-50%)",
                background: "var(--mz-bg-secondary, #333)", color: "var(--mz-text-primary, #fff)",
                padding: "8px 20px", borderRadius: "6px", fontSize: "13px", zIndex: "10000",
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)", transition: "opacity 300ms", opacity: "1",
            });
            document.body.appendChild(this.noticeEl);
            setTimeout(() => {
                this.noticeEl.style.opacity = "0";
                setTimeout(() => this.noticeEl.remove(), 300);
            }, timeout || 4000);
        }
        hide() { this.noticeEl.remove(); }
        setMessage(msg: string) { this.noticeEl.textContent = msg; }
    }

    // Plugin base class — plugins extend this
    class Plugin {
        app: any;
        manifest: any;
        _commands: any[] = [];
        _ribbonIcons: any[] = [];
        _events: any[] = [];
        _intervals: number[] = [];
        _children: any[] = [];
        _domListeners: Array<{ el: any; type: string; callback: any; options?: any }> = [];

        constructor(app?: any, manifest?: any) {
            if (app) this.app = app;
            if (manifest) this.manifest = manifest;
        }

        addCommand(cmd: any) {
            this._commands.push(cmd);
            const fullId = cmd.id?.includes(":") ? cmd.id : `${pluginId}:${cmd.id}`;
            cmd.id = fullId;
            pluginCommandRegistry.set(fullId, {
                id: fullId,
                name: cmd.name ?? fullId,
                callback: cmd.callback,
                editorCallback: cmd.editorCallback,
                hotkeys: cmd.hotkeys,
                icon: cmd.icon,
                pluginId,
            });
            console.log(`[Plugin:${pluginId}] Command: ${cmd.name}`);
            return cmd;
        }

        addRibbonIcon(icon: string, title: string, callback: () => void) {
            this._ribbonIcons.push({ icon, title, callback });
            // Return a dummy element
            const el = document.createElement("div");
            return el;
        }

        addSettingTab(tab: any) {
            pluginSettingTabs.set(pluginId, tab);
            console.log(`[Plugin:${pluginId}] Setting tab registered`);
        }

        addStatusBarItem() {
            const el = document.createElement("span");
            el.style.cssText = "font-size:11px;color:var(--mz-text-muted);margin-left:8px;";
            el.setAttribute("data-plugin-id", pluginId);
            const sb = document.querySelector("[data-statusbar]");
            if (sb) sb.appendChild(el);
            return el;
        }

        registerView(type: string, viewCreator: (leaf: any) => any) {
            pluginViewRegistry.set(type, viewCreator);
            // Store outline view creator on the plugin instance so
            // MindZJ's Outline component can mount it in the sidebar.
            if (type.includes("outline")) {
                (this as any)._outlineViewCreator = viewCreator;
            }
            console.log(`[Plugin:${pluginId}] View registered: ${type}`);
        }

        registerExtensions(extensions: string[], viewType: string) {
            for (const ext of extensions) {
                pluginExtensionMap.set(ext, viewType);
            }
            console.log(`[Plugin:${pluginId}] Extensions registered: ${extensions.join(",")} -> ${viewType}`);
        }

        registerEvent(eventRef: any) {
            this._events.push(eventRef);
            return eventRef;
        }

        registerInterval(id: number) {
            this._intervals.push(id);
            return id;
        }

        registerMarkdownPostProcessor(_processor: any) {}
        registerEditorExtension(_ext: any) {
            // Store extensions — Editor.tsx reads these on next rebuild
            if (!Array.isArray((window as any).__mindzj_plugin_cm_extensions)) {
                (window as any).__mindzj_plugin_cm_extensions = [];
            }
            if (Array.isArray(_ext)) {
                (window as any).__mindzj_plugin_cm_extensions.push(..._ext);
            } else if (_ext) {
                (window as any).__mindzj_plugin_cm_extensions.push(_ext);
            }
        }
        registerMarkdownCodeBlockProcessor(_lang: string, _handler: any) {}
        registerDomEvent(el: any, type: string, callback: any, options?: any) {
            el?.addEventListener?.(type, callback, options);
            this._domListeners.push({ el, type, callback, options });
        }

        async loadData(): Promise<any> {
            try {
                const r = await invoke<{ content: string }>("read_file", {
                    relativePath: `.mindzj/plugins/${getPluginDataDir(pluginId)}/data.json`,
                });
                return JSON.parse(r.content);
            } catch {
                return null;
            }
        }

        async saveData(data: any): Promise<void> {
            try {
                await invoke("write_file", {
                    relativePath: `.mindzj/plugins/${getPluginDataDir(pluginId)}/data.json`,
                    content: JSON.stringify(data, null, 2),
                });
            } catch (e) {
                console.warn(`[Plugin:${pluginId}] saveData error:`, e);
            }
        }

        onload() {}
        onunload() {
            // Clear intervals
            for (const id of this._intervals) clearInterval(id);
            // Remove registered DOM event listeners
            for (const { el, type, callback, options } of this._domListeners) {
                try { el?.removeEventListener?.(type, callback, options); } catch {}
            }
            this._domListeners = [];
        }

        addChild(child: any) {
            this._children.push(child);
            if (child.onload) child.onload();
            return child;
        }
        removeChild(child: any) {
            if (child.onunload) child.onunload();
        }
    }

    // PluginSettingTab
    class PluginSettingTab {
        app: any;
        plugin: any;
        containerEl: HTMLElement;
        icon?: string;
        constructor(app: any, plugin: any) {
            this.app = app;
            this.plugin = plugin;
            this.containerEl = document.createElement("div");
            this.containerEl.className = "vertical-tab-content";
        }
        display() {}
        hide() {}
    }

    // Setting — Obsidian-compatible settings UI
    class Setting {
        settingEl: HTMLElement;
        nameEl: HTMLElement;
        descEl: HTMLElement;
        controlEl: HTMLElement;
        infoEl: HTMLElement;
        _isHeading: boolean = false;
        constructor(containerEl: HTMLElement) {
            this.settingEl = document.createElement("div");
            this.settingEl.className = "setting-item";
            Object.assign(this.settingEl.style, {
                display: "flex", "align-items": "center", "justify-content": "space-between",
                padding: "12px 0", "border-bottom": "1px solid var(--mz-border)",
                gap: "12px",
            });
            this.infoEl = document.createElement("div");
            this.infoEl.className = "setting-item-info";
            Object.assign(this.infoEl.style, { flex: "1", "min-width": "0" });
            this.nameEl = document.createElement("div");
            this.nameEl.className = "setting-item-name";
            Object.assign(this.nameEl.style, {
                "font-size": "14px", "font-weight": "500",
                color: "var(--mz-text-primary)", "margin-bottom": "2px",
            });
            this.descEl = document.createElement("div");
            this.descEl.className = "setting-item-description";
            Object.assign(this.descEl.style, {
                "font-size": "12px", color: "var(--mz-text-muted)",
                "line-height": "1.4",
            });
            this.controlEl = document.createElement("div");
            this.controlEl.className = "setting-item-control";
            Object.assign(this.controlEl.style, {
                display: "flex", "align-items": "center", gap: "8px", "flex-shrink": "0",
            });
            this.infoEl.appendChild(this.nameEl);
            this.infoEl.appendChild(this.descEl);
            this.settingEl.appendChild(this.infoEl);
            this.settingEl.appendChild(this.controlEl);
            containerEl.appendChild(this.settingEl);
        }
        setName(name: string | DocumentFragment) {
            if (typeof name === "string") this.nameEl.textContent = name;
            else { this.nameEl.textContent = ""; this.nameEl.appendChild(name); }
            return this;
        }
        setDesc(desc: string | DocumentFragment) {
            if (typeof desc === "string") {
                // Support basic HTML in description (links, code, etc.)
                if (desc.includes("<") && desc.includes(">")) {
                    this.descEl.innerHTML = desc;
                } else {
                    this.descEl.textContent = desc;
                }
            } else if (desc instanceof DocumentFragment) {
                this.descEl.textContent = "";
                this.descEl.appendChild(desc);
            } else if ((desc as any) instanceof HTMLElement) {
                this.descEl.textContent = "";
                this.descEl.appendChild(desc as any);
            }
            return this;
        }
        setHeading() {
            this._isHeading = true;
            this.settingEl.classList.add("setting-item-heading");
            Object.assign(this.nameEl.style, { "font-size": "16px", "font-weight": "600" });
            this.settingEl.style.borderBottom = "none";
            this.settingEl.style.paddingTop = "18px";
            return this;
        }
        setClass(cls: string) { this.settingEl.classList.add(cls); return this; }
        setDisabled(disabled: boolean) {
            this.settingEl.style.opacity = disabled ? "0.5" : "1";
            this.settingEl.style.pointerEvents = disabled ? "none" : "auto";
            return this;
        }
        addText(cb: (text: any) => void) {
            const input = document.createElement("input");
            input.type = "text";
            Object.assign(input.style, {
                padding: "4px 8px", border: "1px solid var(--mz-border)", "border-radius": "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                "font-size": "13px", width: "200px", outline: "none",
            });
            input.addEventListener("focus", () => { input.style.borderColor = "var(--mz-accent)"; });
            input.addEventListener("blur", () => { input.style.borderColor = "var(--mz-border)"; });
            const wrapper = { inputEl: input, getValue: () => input.value, setValue: (v: string) => { input.value = v; return wrapper; }, setPlaceholder: (p: string) => { input.placeholder = p; return wrapper; }, onChange: (fn: (v: string) => void) => { input.addEventListener("change", () => fn(input.value)); return wrapper; } };
            this.controlEl.appendChild(input);
            cb(wrapper);
            return this;
        }
        addTextArea(cb: (ta: any) => void) {
            const ta = document.createElement("textarea");
            Object.assign(ta.style, {
                padding: "6px 8px", border: "1px solid var(--mz-border)", "border-radius": "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                "font-size": "13px", width: "200px", "min-height": "60px", resize: "vertical", outline: "none",
            });
            ta.addEventListener("focus", () => { ta.style.borderColor = "var(--mz-accent)"; });
            ta.addEventListener("blur", () => { ta.style.borderColor = "var(--mz-border)"; });
            const w = { inputEl: ta, getValue: () => ta.value, setValue: (v: string) => { ta.value = v; return w; }, setPlaceholder: (p: string) => { ta.placeholder = p; return w; }, onChange: (fn: (v: string) => void) => { ta.addEventListener("change", () => fn(ta.value)); return w; } };
            this.controlEl.appendChild(ta);
            cb(w);
            return this;
        }
        addToggle(cb: (toggle: any) => void) {
            let val = false;
            let changeFn: ((v: boolean) => void) | null = null;
            const toggleEl = document.createElement("div");
            Object.assign(toggleEl.style, {
                width: "40px", height: "22px", "border-radius": "11px", cursor: "pointer",
                background: "var(--mz-bg-hover)", position: "relative", transition: "background 150ms",
            });
            const thumb = document.createElement("div");
            Object.assign(thumb.style, {
                width: "18px", height: "18px", "border-radius": "50%", background: "white",
                position: "absolute", top: "2px", left: "2px", transition: "left 150ms",
                "box-shadow": "0 1px 3px rgba(0,0,0,0.3)",
            });
            toggleEl.appendChild(thumb);
            function updateVisual() {
                toggleEl.style.background = val ? "var(--mz-accent)" : "var(--mz-bg-hover)";
                thumb.style.left = val ? "20px" : "2px";
            }
            toggleEl.addEventListener("click", () => {
                if ((toggleEl as any)._disabled) return;
                val = !val;
                updateVisual();
                if (changeFn) changeFn(val);
            });
            const w = {
                toggleEl,
                getValue: () => val,
                setValue: (v: boolean) => { val = v; updateVisual(); return w; },
                onChange: (fn: (v: boolean) => void) => { changeFn = fn; return w; },
                setDisabled: (disabled: boolean) => { toggleEl.style.opacity = disabled ? "0.5" : "1"; (toggleEl as any)._disabled = disabled; return w; },
            };
            this.controlEl.appendChild(toggleEl);
            cb(w);
            updateVisual();
            return this;
        }
        addDropdown(cb: (dd: any) => void) {
            const sel = document.createElement("select");
            Object.assign(sel.style, {
                padding: "4px 8px", border: "1px solid var(--mz-border)", "border-radius": "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                "font-size": "13px", outline: "none", cursor: "pointer",
            });
            const w = { selectEl: sel, getValue: () => sel.value, setValue: (v: string) => { sel.value = v; return w; }, addOption: (val: string, display: string) => { const o = document.createElement("option"); o.value = val; o.textContent = display; sel.appendChild(o); return w; }, addOptions: (opts: Record<string, string>) => { Object.entries(opts).forEach(([k, v]) => { const o = document.createElement("option"); o.value = k; o.textContent = v; sel.appendChild(o); }); return w; }, onChange: (fn: (v: string) => void) => { sel.addEventListener("change", () => fn(sel.value)); return w; } };
            this.controlEl.appendChild(sel);
            cb(w);
            return this;
        }
        addButton(cb: (btn: any) => void) {
            const btn = document.createElement("button");
            Object.assign(btn.style, {
                padding: "4px 12px", border: "1px solid var(--mz-border)", "border-radius": "4px",
                background: "var(--mz-bg-secondary)", color: "var(--mz-text-primary)",
                "font-size": "13px", cursor: "pointer",
            });
            btn.addEventListener("mouseenter", () => { btn.style.borderColor = "var(--mz-accent)"; });
            btn.addEventListener("mouseleave", () => { btn.style.borderColor = "var(--mz-border)"; });
            const w = { buttonEl: btn, setButtonText: (t: string) => { btn.textContent = t; return w; }, setCta: () => { btn.style.background = "var(--mz-accent)"; btn.style.color = "white"; btn.style.borderColor = "var(--mz-accent)"; return w; }, setIcon: (_i: string) => w, setTooltip: (t: string) => { btn.title = t; return w; }, onClick: (fn: () => void) => { btn.addEventListener("click", fn); return w; }, setWarning: () => { btn.style.color = "var(--mz-error, #e06c75)"; return w; }, setDisabled: (d: boolean) => { btn.disabled = d; btn.style.opacity = d ? "0.5" : "1"; return w; }, setClass: (cls: string) => { btn.classList.add(...cls.split(/\s+/).filter(Boolean)); return w; } };
            this.controlEl.appendChild(btn);
            cb(w);
            return this;
        }
        addSlider(cb: (slider: any) => void) {
            const input = document.createElement("input");
            input.type = "range";
            Object.assign(input.style, { width: "120px", cursor: "pointer", "accent-color": "var(--mz-accent)" });
            const w = { sliderEl: input, getValue: () => Number(input.value), setValue: (v: number) => { input.value = String(v); return w; }, setLimits: (min: number, max: number, step: number) => { input.min = String(min); input.max = String(max); input.step = String(step); return w; }, setDynamicTooltip: () => w, onChange: (fn: (v: number) => void) => { input.addEventListener("input", () => fn(Number(input.value))); return w; }, showTooltip: () => w };
            this.controlEl.appendChild(input);
            cb(w);
            return this;
        }
        addColorPicker(cb: (cp: any) => void) {
            const input = document.createElement("input");
            input.type = "color";
            Object.assign(input.style, {
                width: "32px", height: "28px", padding: "2px", border: "1px solid var(--mz-border)",
                "border-radius": "4px", background: "var(--mz-bg-primary)", cursor: "pointer",
            });
            const w = { getValue: () => input.value, setValue: (v: string) => { input.value = v; return w; }, onChange: (fn: (v: string) => void) => { input.addEventListener("input", () => fn(input.value)); return w; } };
            this.controlEl.appendChild(input);
            cb(w);
            return this;
        }
        addExtraButton(cb: (btn: any) => void) {
            const btn = document.createElement("button");
            Object.assign(btn.style, {
                width: "24px", height: "24px", border: "none", background: "transparent",
                color: "var(--mz-text-muted)", cursor: "pointer", display: "flex",
                "align-items": "center", "justify-content": "center", "border-radius": "4px",
            });
            btn.addEventListener("mouseenter", () => { btn.style.color = "var(--mz-text-primary)"; });
            btn.addEventListener("mouseleave", () => { btn.style.color = "var(--mz-text-muted)"; });
            const w = { extraSettingsEl: btn, setIcon: (i: string) => { const icons = (window as any).__mindzj_icons || {}; if (icons[i]) { btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[i]}</svg>`; } return w; }, setTooltip: (t: string) => { btn.title = t; return w; }, onClick: (fn: () => void) => { btn.addEventListener("click", fn); return w; }, setDisabled: (d: boolean) => { btn.disabled = d; return w; } };
            this.controlEl.appendChild(btn);
            cb(w);
            return this;
        }
        addSearch(cb: (search: any) => void) {
            const container = document.createElement("div");
            Object.assign(container.style, { position: "relative", display: "inline-block" });
            const input = document.createElement("input");
            input.type = "search";
            Object.assign(input.style, {
                padding: "4px 8px", border: "1px solid var(--mz-border)", "border-radius": "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                "font-size": "13px", width: "200px", outline: "none",
            });
            input.addEventListener("focus", () => { input.style.borderColor = "var(--mz-accent)"; });
            input.addEventListener("blur", () => { input.style.borderColor = "var(--mz-border)"; });
            // Suggestion dropdown
            const suggestEl = document.createElement("div");
            Object.assign(suggestEl.style, {
                position: "absolute", top: "100%", left: "0", right: "0",
                background: "var(--mz-bg-secondary)", border: "1px solid var(--mz-border)",
                "border-radius": "4px", "max-height": "200px", overflow: "auto",
                "z-index": "100", display: "none", "box-shadow": "0 4px 12px rgba(0,0,0,0.2)",
            });
            container.appendChild(input);
            container.appendChild(suggestEl);
            let changeFn: ((v: string) => void) | null = null;
            const w = {
                inputEl: input,
                getValue: () => input.value,
                setValue: (v: string) => { input.value = v; return w; },
                setPlaceholder: (p: string) => { input.placeholder = p; return w; },
                onChange: (fn: (v: string) => void) => { changeFn = fn; input.addEventListener("change", () => fn(input.value)); return w; },
                onChanged: () => { if (changeFn) changeFn(input.value); },
            };
            this.controlEl.appendChild(container);
            cb(w);
            return this;
        }
        addProgressBar() {
            const bar = document.createElement("div");
            Object.assign(bar.style, {
                width: "100%", height: "4px", background: "var(--mz-bg-hover)",
                "border-radius": "2px", overflow: "hidden", "margin-top": "8px",
            });
            const fill = document.createElement("div");
            Object.assign(fill.style, {
                width: "0%", height: "100%", background: "var(--mz-accent)",
                transition: "width 200ms ease",
            });
            bar.appendChild(fill);
            this.settingEl.appendChild(bar);
            return { barEl: bar, setValue: (v: number) => { fill.style.width = `${Math.max(0, Math.min(100, v))}%`; } };
        }
        clear() {
            this.controlEl.innerHTML = "";
            return this;
        }
        then(cb: (setting: Setting) => void) { cb(this); return this; }
    }

    class SettingGroup {
        containerEl: HTMLElement;
        private headingEl: HTMLElement | null = null;
        constructor(containerEl: HTMLElement) {
            this.containerEl = containerEl;
            this.containerEl.classList.add("setting-group");
        }
        setHeading(title: string) {
            if (!this.headingEl) {
                this.headingEl = document.createElement("div");
                this.headingEl.className = "setting-group-heading";
                this.containerEl.prepend(this.headingEl);
            }
            this.headingEl.textContent = title;
            return this;
        }
        addSetting(cb: (setting: Setting) => void) {
            const setting = new Setting(this.containerEl);
            cb(setting);
            return setting;
        }
    }

    // View classes
    class ItemView {
        app: any;
        containerEl: HTMLElement;
        contentEl: HTMLElement;
        leaf: any;
        icon: string = "";
        navigation: boolean = true;
        constructor(leaf: any) {
            this.leaf = leaf;
            // Set app from leaf (Obsidian pattern: this.app = leaf.app)
            if (leaf?.app) this.app = leaf.app;
            // Build containerEl with Obsidian's expected structure:
            //   containerEl.children[0] = view-header (div)
            //   containerEl.children[1] = view-content (div) = contentEl
            // The plugin accesses content via: this.containerEl.children[1]
            this.containerEl = document.createElement("div");
            this.containerEl.className = "view-container";
            // Use flexbox so the contentEl fills remaining space after header.
            // Without this, the plugin's SVG canvas won't fill the area and
            // mouse events (drag, right-click, selection) won't work properly.
            Object.assign(this.containerEl.style, {
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
            });
            const headerEl = document.createElement("div");
            headerEl.className = "view-header";
            headerEl.style.flexShrink = "0";
            this.containerEl.appendChild(headerEl);
            this.contentEl = document.createElement("div");
            this.contentEl.className = "view-content";
            Object.assign(this.contentEl.style, {
                flex: "1",
                width: "100%",
                minHeight: "0",      // allow flex child to shrink below content
                position: "relative",
                overflow: "hidden",
            });
            this.containerEl.appendChild(this.contentEl);
        }
        getViewType() { return ""; }
        getDisplayText() { return ""; }
        getIcon() { return this.icon; }
        async onOpen() {}
        async onClose() {}
        onResize() {}
    }

    class MarkdownView extends ItemView {
        editor: any = {};
        file: any = null;
        getViewType() { return "markdown"; }
    }

    class TextFileView extends ItemView {
        data: string = "";
        file: any = null;
        requestSave() {
            // Will be overridden by mountPluginView with actual save logic
            if (this.file && this.app) {
                const data = this.getViewData();
                this.app.vault.modify(this.file, data);
            }
        }
        getViewData() { return this.data; }
        setViewData(data: string, _clear: boolean) { this.data = data; }
        clear() { this.data = ""; }
        onLoadFile(_file: any) { return Promise.resolve(); }
        onUnloadFile(_file: any) { return Promise.resolve(); }
    }

    // Modal — with Obsidian-matching backdrop and close button
    class Modal {
        app: any;
        contentEl: HTMLElement;
        modalEl: HTMLElement;
        titleEl: HTMLElement;
        scope: any;
        _backdropEl: HTMLElement | null = null;
        containerEl: HTMLElement;
        constructor(app: any) {
            this.app = app;
            // Backdrop overlay
            this._backdropEl = document.createElement("div");
            this._backdropEl.className = "modal-container";
            Object.assign(this._backdropEl.style, {
                position: "fixed", inset: "0", zIndex: "10000",
                background: "rgba(0,0,0,0.5)", display: "flex",
                alignItems: "center", justifyContent: "center",
            });
            this._backdropEl.addEventListener("click", (e: MouseEvent) => {
                if (e.target === this._backdropEl) this.close();
            });
            // Modal dialog
            this.modalEl = document.createElement("div");
            this.modalEl.className = "modal";
            Object.assign(this.modalEl.style, {
                background: "var(--mz-bg-secondary,#2b2b2b)", border: "1px solid var(--mz-border,#444)",
                borderRadius: "8px", padding: "24px", minWidth: "300px", maxWidth: "90vw",
                maxHeight: "85vh", overflow: "auto",
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)", color: "var(--mz-text-primary,#ddd)",
            });
            // Close button
            const closeBtn = document.createElement("div");
            closeBtn.className = "modal-close-button";
            closeBtn.innerHTML = "&times;";
            Object.assign(closeBtn.style, {
                position: "absolute", top: "8px", right: "12px",
                fontSize: "20px", cursor: "pointer", color: "var(--mz-text-muted)",
                lineHeight: "1", width: "24px", height: "24px",
                display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "4px",
            });
            closeBtn.addEventListener("click", () => this.close());
            closeBtn.addEventListener("mouseenter", () => { closeBtn.style.color = "var(--mz-text-primary)"; closeBtn.style.background = "var(--mz-bg-hover)"; });
            closeBtn.addEventListener("mouseleave", () => { closeBtn.style.color = "var(--mz-text-muted)"; closeBtn.style.background = "transparent"; });
            this.modalEl.style.position = "relative";
            this.modalEl.appendChild(closeBtn);
            this.titleEl = document.createElement("h2");
            Object.assign(this.titleEl.style, { margin: "0 0 16px", fontSize: "18px", fontWeight: "600" });
            this.contentEl = document.createElement("div");
            this.containerEl = this.modalEl;
            this.modalEl.appendChild(this.titleEl);
            this.modalEl.appendChild(this.contentEl);
            this._backdropEl.appendChild(this.modalEl);
            this.scope = {};
        }
        open() {
            document.body.appendChild(this._backdropEl!);
            this.onOpen();
        }
        close() {
            if (this._backdropEl) this._backdropEl.remove();
            this.onClose();
        }
        onOpen() {}
        onClose() {}
        setTitle(title: string) { this.titleEl.textContent = title; }
    }

    class FuzzySuggestModal extends Modal {
        inputEl: HTMLInputElement;
        resultsEl: HTMLElement;
        constructor(app: any) {
            super(app);
            this.inputEl = document.createElement("input");
            this.resultsEl = document.createElement("div");
        }
        setPlaceholder(text: string) {
            this.inputEl.placeholder = text;
            return this;
        }
        getItems(): any[] { return []; }
        getItemText(item: any) { return String(item ?? ""); }
        onChooseItem(_item: any, _evt?: MouseEvent | KeyboardEvent) {}
        onOpen() {
            (this.contentEl as any).empty?.();
            if (!(this.contentEl as any).empty) {
                this.contentEl.innerHTML = "";
            }
            Object.assign(this.inputEl.style, {
                width: "100%",
                padding: "8px 10px",
                border: "1px solid var(--mz-border)",
                borderRadius: "6px",
                background: "var(--mz-bg-primary)",
                color: "var(--mz-text-primary)",
                marginBottom: "12px",
                outline: "none",
            });
            Object.assign(this.resultsEl.style, {
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                maxHeight: "320px",
                overflow: "auto",
            });
            this.contentEl.appendChild(this.inputEl);
            this.contentEl.appendChild(this.resultsEl);
            const render = () => {
                const query = this.inputEl.value.trim().toLowerCase();
                const items = this.getItems().filter((item) => {
                    const text = this.getItemText(item).toLowerCase();
                    return !query || text.includes(query);
                });
                (this.resultsEl as any).empty?.();
                if (!(this.resultsEl as any).empty) {
                    this.resultsEl.innerHTML = "";
                }
                for (const item of items.slice(0, 50)) {
                    const row = (this.resultsEl as any).createDiv ? (this.resultsEl as any).createDiv() : document.createElement("div");
                    if (!row.parentElement) this.resultsEl.appendChild(row);
                    Object.assign(row.style, {
                        padding: "8px 10px",
                        borderRadius: "6px",
                        cursor: "pointer",
                    });
                    row.textContent = this.getItemText(item);
                    row.addEventListener("mouseenter", () => { row.style.background = "var(--mz-bg-hover)"; });
                    row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
                    row.addEventListener("click", (evt: MouseEvent) => {
                        this.onChooseItem(item, evt);
                        this.close();
                    });
                }
            };
            this.inputEl.addEventListener("input", render);
            this.inputEl.addEventListener("keydown", (evt) => {
                if (evt.key === "Escape") this.close();
            });
            render();
            setTimeout(() => this.inputEl.focus(), 0);
        }
    }

    // TFile / TFolder / TAbstractFile
    class TAbstractFile {
        path: string;
        name: string;
        parent: any;
        vault: any;
        constructor() { this.path = ""; this.name = ""; }
    }

    class TFile extends TAbstractFile {
        stat: any = { mtime: 0, ctime: 0, size: 0 };
        basename: string = "";
        extension: string = "";
        constructor() { super(); }
    }

    class TFolder extends TAbstractFile {
        children: any[] = [];
        isRoot() { return this.path === "/"; }
        constructor() { super(); }
    }

    // Menu — renders a real context menu at mouse position
    class Menu {
        items: any[] = [];
        dom: HTMLElement;
        _backdrop: HTMLElement | null = null;
        constructor() {
            this.dom = document.createElement("div");
            this.dom.className = "menu obsidian-menu";
            Object.assign(this.dom.style, {
                position: "fixed",
                zIndex: "10002",
                background: "var(--mz-bg-secondary, #2b2b2b)",
                border: "1px solid var(--mz-border-strong, #555)",
                borderRadius: "6px",
                padding: "4px 0",
                minWidth: "160px",
                maxWidth: "320px",
                boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
                fontSize: "13px",
                color: "var(--mz-text-primary, #ccc)",
                fontFamily: "var(--mz-font-sans, system-ui)",
                userSelect: "none",
                display: "none",
            });
        }
        addItem(cb: (item: any) => void) {
            const dom = document.createElement("div");
            dom.className = "menu-item";
            Object.assign(dom.style, {
                padding: "6px 16px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                borderRadius: "0",
                transition: "background 80ms",
            });
            const item: any = {
                dom,
                titleEl: document.createElement("span"),
                iconEl: document.createElement("span"),
                _disabled: false,
                _submenu: null as any,
                setTitle: (t: string) => { item.title = t; item.titleEl.textContent = t; return item; },
                setIcon: (i: string) => {
                    item.icon = i;
                    const icons = (window as any).__mindzj_icons || {};
                    item.iconEl.innerHTML = icons[i]
                        ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[i]}</svg>`
                        : (i ? "•" : "");
                    return item;
                },
                onClick: (fn: (evt?: MouseEvent) => void) => { item.callback = fn; return item; },
                setSection: (s: string) => { item.section = s; return item; },
                setChecked: (_c: boolean) => item,
                setDisabled: (d: boolean) => { item._disabled = d; return item; },
                setSubmenu: () => {
                    item._submenu = new Menu();
                    return item._submenu;
                },
            };
            item.iconEl.style.width = "14px";
            item.iconEl.style.flexShrink = "0";
            item.titleEl.style.flex = "1";
            dom.appendChild(item.iconEl);
            dom.appendChild(item.titleEl);
            dom.appendChild(document.createElement("span"));
            this.items.push(item);
            cb(item);
            return this;
        }
        addSeparator() {
            this.items.push({ _separator: true });
            return this;
        }
        private _render() {
            this.dom.innerHTML = "";
            for (const item of this.items) {
                if (item._separator) {
                    const sep = document.createElement("div");
                    Object.assign(sep.style, {
                        height: "1px",
                        background: "var(--mz-border, #3e3e3e)",
                        margin: "4px 8px",
                    });
                    this.dom.appendChild(sep);
                    continue;
                }
                const row = item.dom;
                row.style.opacity = item._disabled ? "0.4" : "1";
                row.style.cursor = item._disabled ? "default" : "pointer";
                row.style.background = "transparent";
                const arrow = row.lastChild as HTMLElement;
                arrow.textContent = item._submenu ? "›" : "";
                arrow.style.marginLeft = "8px";
                arrow.style.color = "var(--mz-text-muted)";
                if (!item._disabled) {
                    row.addEventListener("mouseenter", () => {
                        row.style.background = "var(--mz-bg-hover, #333)";
                    });
                    row.addEventListener("mouseleave", () => {
                        row.style.background = "transparent";
                    });
                    row.addEventListener("click", (e: MouseEvent) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (item._submenu) {
                            item._submenu.close();
                            const rect = row.getBoundingClientRect();
                            item._submenu.showAtPosition({ x: rect.right - 4, y: rect.top });
                            return;
                        }
                        this.close();
                        if (item.callback) item.callback(e);
                    });
                }
                this.dom.appendChild(row);
            }
        }
        showAtMouseEvent(e: any) {
            this._render();
            this.dom.style.display = "block";
            document.body.appendChild(this.dom);
            // Position at mouse, clamped within viewport
            const mx = e.clientX ?? e.pageX ?? 0;
            const my = e.clientY ?? e.pageY ?? 0;
            const rect = this.dom.getBoundingClientRect();
            const x = Math.min(mx, window.innerWidth - rect.width - 8);
            const y = Math.min(my, window.innerHeight - rect.height - 8);
            this.dom.style.left = Math.max(0, x) + "px";
            this.dom.style.top = Math.max(0, y) + "px";
            // Close on outside click
            this._backdrop = document.createElement("div");
            Object.assign(this._backdrop.style, {
                position: "fixed", inset: "0", zIndex: "10001", background: "transparent",
            });
            this._backdrop.addEventListener("mousedown", (ev: MouseEvent) => {
                ev.preventDefault();
                this.close();
            });
            this._backdrop.addEventListener("contextmenu", (ev: MouseEvent) => {
                ev.preventDefault();
                this.close();
            });
            document.body.appendChild(this._backdrop);
        }
        showAtPosition(pos: any) {
            this._render();
            this.dom.style.display = "block";
            document.body.appendChild(this.dom);
            this.dom.style.left = (pos?.x ?? 0) + "px";
            this.dom.style.top = (pos?.y ?? 0) + "px";
            this._backdrop = document.createElement("div");
            Object.assign(this._backdrop.style, {
                position: "fixed", inset: "0", zIndex: "10001", background: "transparent",
            });
            this._backdrop.addEventListener("mousedown", () => this.close());
            document.body.appendChild(this._backdrop);
        }
        close() {
            this.dom.remove();
            if (this._backdrop) { this._backdrop.remove(); this._backdrop = null; }
        }
        hide() { this.close(); }
    }

    // Component — used for lifecycle management
    class Component {
        _children: any[] = [];
        _loaded: boolean = false;
        load() { this._loaded = true; }
        unload() { this._loaded = false; this._children.forEach((c: any) => c.unload?.()); }
        addChild(child: any) { this._children.push(child); if (this._loaded) child.load?.(); return child; }
        removeChild(child: any) { child.unload?.(); }
        register(_cb: () => void) {}
        registerEvent(_eventRef: any) {}
        registerDomEvent(el: any, type: string, callback: any, options?: any) { el?.addEventListener?.(type, callback, options); }
        registerInterval(id: number) { return id; }
    }

    // Keymap
    const Keymap = {
        isModifier: (e: KeyboardEvent, modifier: string) => {
            if (modifier === "Mod") return e.ctrlKey || e.metaKey;
            if (modifier === "Ctrl") return e.ctrlKey;
            if (modifier === "Meta") return e.metaKey;
            if (modifier === "Shift") return e.shiftKey;
            if (modifier === "Alt") return e.altKey;
            return false;
        },
        isModEvent: (e: MouseEvent) => e.ctrlKey || e.metaKey,
    };

    // Scope
    class Scope {
        register(_modifiers: string[], _key: string | null, _fn: (e: KeyboardEvent) => boolean | void) {}
        unregister(_handler: any) {}
    }

    class WorkspaceWindow {
        containerEl: HTMLElement;
        constructor() {
            this.containerEl = document.body;
        }
    }

    function makeThenable<T extends object>(target: T): T & PromiseLike<T> {
        return Object.assign(target, {
            then(cb: (value: T) => any) {
                return Promise.resolve(cb(target));
            },
        });
    }

    class ButtonComponent {
        buttonEl: HTMLButtonElement;
        constructor(containerEl: HTMLElement) {
            this.buttonEl = document.createElement("button");
            Object.assign(this.buttonEl.style, {
                padding: "4px 12px", border: "1px solid var(--mz-border)", borderRadius: "4px",
                background: "var(--mz-bg-secondary)", color: "var(--mz-text-primary)",
                fontSize: "13px", cursor: "pointer",
            });
            containerEl.appendChild(this.buttonEl);
        }
        setButtonText(t: string) { this.buttonEl.textContent = t; return this; }
        setCta() { this.buttonEl.style.background = "var(--mz-accent)"; this.buttonEl.style.color = "white"; this.buttonEl.style.borderColor = "var(--mz-accent)"; return this; }
        onClick(fn: () => void) { this.buttonEl.addEventListener("click", fn); return this; }
        setIcon(i: string) {
            const icons = (window as any).__mindzj_icons || {};
            if (icons[i]) {
                this.buttonEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[i]}</svg>`;
            }
            return this;
        }
        setTooltip(t: string) { this.buttonEl.title = t; return this; }
        setDisabled(d: boolean) { this.buttonEl.disabled = d; this.buttonEl.style.opacity = d ? "0.5" : "1"; return this; }
        setWarning() { this.buttonEl.style.color = "var(--mz-error, #e06c75)"; return this; }
        removeCta() { this.buttonEl.style.background = "var(--mz-bg-secondary)"; this.buttonEl.style.color = "var(--mz-text-primary)"; return this; }
        setClass(cls: string) { this.buttonEl.classList.add(...cls.split(/\s+/).filter(Boolean)); return this; }
    }

    class TextComponent {
        inputEl: HTMLInputElement;
        constructor(containerEl: HTMLElement) {
            this.inputEl = document.createElement("input");
            this.inputEl.type = "text";
            Object.assign(this.inputEl.style, {
                padding: "4px 8px", border: "1px solid var(--mz-border)", borderRadius: "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                fontSize: "13px", width: "200px", outline: "none",
            });
            containerEl.appendChild(this.inputEl);
            return makeThenable(this);
        }
        getValue() { return this.inputEl.value; }
        setValue(v: string) { this.inputEl.value = v; return this; }
        setPlaceholder(p: string) { this.inputEl.placeholder = p; return this; }
        onChange(fn: (v: string) => void) { this.inputEl.addEventListener("change", () => fn(this.inputEl.value)); return this; }
    }

    class TextAreaComponent {
        inputEl: HTMLTextAreaElement;
        constructor(containerEl: HTMLElement) {
            this.inputEl = document.createElement("textarea");
            Object.assign(this.inputEl.style, {
                padding: "6px 8px", border: "1px solid var(--mz-border)", borderRadius: "4px",
                background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                fontSize: "13px", width: "200px", minHeight: "60px", resize: "vertical", outline: "none",
            });
            containerEl.appendChild(this.inputEl);
            return makeThenable(this);
        }
        getValue() { return this.inputEl.value; }
        setValue(v: string) { this.inputEl.value = v; return this; }
        setPlaceholder(p: string) { this.inputEl.placeholder = p; return this; }
        onChange(fn: (v: string) => void) { this.inputEl.addEventListener("change", () => fn(this.inputEl.value)); return this; }
    }

    class ToggleComponent {
        toggleEl: HTMLElement;
        _val: boolean = false;
        _changeFn: ((v: boolean) => void) | null = null;
        constructor(containerEl: HTMLElement) {
            this.toggleEl = document.createElement("div");
            Object.assign(this.toggleEl.style, {
                width: "40px", height: "22px", borderRadius: "11px", cursor: "pointer",
                background: "var(--mz-bg-hover)", position: "relative", transition: "background 150ms",
            });
            const thumb = document.createElement("div");
            Object.assign(thumb.style, {
                width: "18px", height: "18px", borderRadius: "50%", background: "white",
                position: "absolute", top: "2px", left: "2px", transition: "left 150ms",
                boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            });
            this.toggleEl.appendChild(thumb);
            this.toggleEl.addEventListener("click", () => {
                if ((this.toggleEl as any)._disabled) return;
                this._val = !this._val;
                this.toggleEl.style.background = this._val ? "var(--mz-accent)" : "var(--mz-bg-hover)";
                thumb.style.left = this._val ? "20px" : "2px";
                if (this._changeFn) this._changeFn(this._val);
            });
            containerEl.appendChild(this.toggleEl);
        }
        getValue() { return this._val; }
        setValue(v: boolean) { this._val = v; this.toggleEl.style.background = v ? "var(--mz-accent)" : "var(--mz-bg-hover)"; (this.toggleEl.firstChild as HTMLElement).style.left = v ? "20px" : "2px"; return this; }
        onChange(fn: (v: boolean) => void) { this._changeFn = fn; return this; }
        setDisabled(disabled: boolean) { (this.toggleEl as any)._disabled = disabled; this.toggleEl.style.opacity = disabled ? "0.5" : "1"; return this; }
    }

    class SliderComponent {
        sliderEl: HTMLInputElement;
        constructor(containerEl: HTMLElement) {
            this.sliderEl = document.createElement("input");
            this.sliderEl.type = "range";
            Object.assign(this.sliderEl.style, {
                width: "140px",
                cursor: "pointer",
                accentColor: "var(--mz-accent)",
            } as any);
            containerEl.appendChild(this.sliderEl);
            return makeThenable(this);
        }
        getValue() { return Number(this.sliderEl.value); }
        setValue(v: number) { this.sliderEl.value = String(v); return this; }
        setLimits(min: number, max: number, step: number) { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
        setDynamicTooltip() { return this; }
        showTooltip() { return this; }
        onChange(fn: (v: number) => void) { this.sliderEl.addEventListener("input", () => fn(Number(this.sliderEl.value))); return this; }
    }

    class FileSystemAdapter {
        _basePath: string;
        constructor(basePath = "") {
            this._basePath = basePath;
        }
        getBasePath() { return this._basePath; }
    }

    return {
        Plugin,
        PluginSettingTab,
        Setting,
        Notice,
        Modal,
        FuzzySuggestModal,
        ItemView,
        MarkdownView,
        TextFileView,
        TAbstractFile,
        TFile,
        TFolder,
        Menu,
        Component,
        Keymap,
        Scope,
        WorkspaceWindow,
        // Platform
        Platform: { isDesktop: true, isMobile: false, isMobileApp: false, isDesktopApp: true, isWin: true, isMacOS: false, isLinux: false },
        requireApiVersion: (_version: string) => true,
        // Utility
        normalizePath: (path: string) => path.replace(/\\/g, "/").replace(/\/+/g, "/"),
        addIcon: (id: string, svgContent: string) => {
            // Store custom icons for later use by setIcon
            if (!(window as any).__mindzj_icons) (window as any).__mindzj_icons = {};
            (window as any).__mindzj_icons[id] = svgContent;
        },
        setIcon: (el: HTMLElement, id: string) => {
            const icons = (window as any).__mindzj_icons || {};
            if (icons[id]) {
                el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[id]}</svg>`;
            }
        },
        setTooltip: (el: HTMLElement, tooltip: string) => { el.title = tooltip; },
        // Debounce
        debounce: (fn: Function, delay: number, _immediate?: boolean) => {
            let timer: any;
            return (...args: any[]) => {
                clearTimeout(timer);
                timer = setTimeout(() => fn(...args), delay);
            };
        },
        // Common classes
        MarkdownRenderChild: class { containerEl: HTMLElement; constructor(el: HTMLElement) { this.containerEl = el; } load() {} unload() {} },
        MarkdownRenderer: {
            renderMarkdown: async (markdown: string, el: HTMLElement) => {
                el.innerHTML = renderMarkdownCompat(markdown);
            },
            render: async (_app: any, markdown: string, el: HTMLElement) => {
                el.innerHTML = renderMarkdownCompat(markdown);
            },
        },
        // Workspace-related
        WorkspaceLeaf: class { view: any; getViewState() { return {}; } setViewState(_s: any) {} },
        SettingGroup,
        // Additional utilities commonly used by plugins
        moment: (window as any).moment || ((...args: any[]) => {
            // Basic moment-like shim for plugins that reference moment
            const d = args.length ? new Date(args[0]) : new Date();
            return {
                format: (fmt: string) => {
                    // Basic date formatting
                    const pad = (n: number) => String(n).padStart(2, "0");
                    return fmt
                        .replace("YYYY", String(d.getFullYear()))
                        .replace("MM", pad(d.getMonth() + 1))
                        .replace("DD", pad(d.getDate()))
                        .replace("HH", pad(d.getHours()))
                        .replace("mm", pad(d.getMinutes()))
                        .replace("ss", pad(d.getSeconds()));
                },
                toDate: () => d,
                valueOf: () => d.getTime(),
                isValid: () => !isNaN(d.getTime()),
            };
        }),
        // Events helper
        Events: class {
            _events: Record<string, Function[]> = {};
            on(name: string, cb: Function) { if (!this._events[name]) this._events[name] = []; this._events[name].push(cb); return this; }
            off(name: string, cb: Function) { if (this._events[name]) this._events[name] = this._events[name].filter(f => f !== cb); }
            trigger(name: string, ...args: any[]) { for (const fn of (this._events[name] || [])) try { fn(...args); } catch {} }
            offref(_ref: any) {}
        },
        ButtonComponent,
        TextComponent,
        TextAreaComponent,
        ToggleComponent,
        SliderComponent,
        // requestUrl — HTTP request helper
        requestUrl: async (req: any) => {
            const url = typeof req === "string" ? req : req.url;
            const method = req?.method || "GET";
            const headers = req?.headers || {};
            const body = req?.body;
            try {
                const resp = await fetch(url, { method, headers, body });
                const buf = await resp.arrayBuffer();
                const text = new TextDecoder().decode(buf);
                let json: any;
                try { json = JSON.parse(text); } catch {}
                return { status: resp.status, headers: Object.fromEntries(resp.headers.entries()), text, json, arrayBuffer: buf };
            } catch (e: any) {
                throw new Error(`Request failed: ${e.message}`);
            }
        },
        // htmlToMarkdown — basic HTML to markdown conversion
        htmlToMarkdown: (html: string) => {
            const tmp = document.createElement("div");
            tmp.innerHTML = html;
            return tmp.textContent || "";
        },
        // sanitizeHTMLToDom
        sanitizeHTMLToDom: (html: string) => {
            const template = document.createElement("template");
            template.innerHTML = html.trim();
            return template.content;
        },
        // Vault-related re-export
        FileSystemAdapter,
    };
}

export const pluginStore = createRoot(createPluginStore);

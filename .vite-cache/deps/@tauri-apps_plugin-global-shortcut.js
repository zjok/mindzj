import {
  Channel,
  invoke
} from "./chunk-YQTFE5VL.js";
import "./chunk-YNBBAPQR.js";

// node_modules/@tauri-apps/plugin-global-shortcut/dist-js/index.js
async function register(shortcuts, handler) {
  const h = new Channel();
  h.onmessage = handler;
  return await invoke("plugin:global-shortcut|register", {
    shortcuts: Array.isArray(shortcuts) ? shortcuts : [shortcuts],
    handler: h
  });
}
async function unregister(shortcuts) {
  return await invoke("plugin:global-shortcut|unregister", {
    shortcuts: Array.isArray(shortcuts) ? shortcuts : [shortcuts]
  });
}
async function unregisterAll() {
  return await invoke("plugin:global-shortcut|unregister_all", {});
}
async function isRegistered(shortcut) {
  return await invoke("plugin:global-shortcut|is_registered", {
    shortcut
  });
}
export {
  isRegistered,
  register,
  unregister,
  unregisterAll
};
//# sourceMappingURL=@tauri-apps_plugin-global-shortcut.js.map

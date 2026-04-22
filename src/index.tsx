/* @refresh reload */
import { render } from "solid-js/web";
import "virtual:uno.css";
import "./styles/variables.css";
// Built-in preset skins. MUST be imported AFTER variables.css so the
// `[data-theme="<id>"]` rules in each file override the fallback
// `:root`/`[data-theme="dark"]` definitions in variables.css.
// Order among the theme files doesn't matter — each one targets a
// distinct `data-theme` attribute value, so their rule sets never
// compete for the same selector.
import "./styles/themes/github-light.css";
import "./styles/themes/github-dark.css";
import "./styles/themes/atom-dark.css";
import "./styles/themes/atom-light.css";
import "./styles/themes/sublime-dark.css";
import "./styles/themes/sublime-light.css";
import "./styles/themes/one-dark.css";
import "./styles/themes/one-light.css";
import "./styles/themes/monokai.css";
import "./styles/themes/nord.css";
import "./styles/themes/tokyo-night.css";
import "./styles/themes/tokyo-night-light.css";
import "./styles/themes/iceberg.css";
import "./styles/themes/gruvbox.css";
import "./styles/themes/gruvbox-light.css";
import "./styles/themes/catppuccin.css";
import "./styles/themes/catppuccin-latte.css";
import "./styles/themes/rose-pine.css";
import "./styles/themes/rose-pine-dawn.css";
import "./styles/themes/everforest-dark.css";
import "./styles/themes/everforest-light.css";
import "./styles/themes/kanagawa.css";
import "./styles/themes/zenburn.css";
import "./styles/themes/papercolor-light.css";
import "./styles/themes/solarized-light.css";
import "./styles/themes/solarized-dark.css";
import "./styles/editor.css";
import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root not found in DOM");
}

render(() => <App />, root);

/* @refresh reload */
import { render } from "solid-js/web";
import "virtual:uno.css";
import "./styles/variables.css";
import "./styles/editor.css";
import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root not found in DOM");
}

render(() => <App />, root);

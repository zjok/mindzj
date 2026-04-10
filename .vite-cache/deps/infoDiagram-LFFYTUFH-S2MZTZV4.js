import {
  parse
} from "./chunk-YB2F3RKJ.js";
import "./chunk-H4LRSSPP.js";
import "./chunk-JJKPW3J6.js";
import "./chunk-N6SYIMTU.js";
import "./chunk-D7KA3FIA.js";
import "./chunk-P4EL3R3U.js";
import "./chunk-UJQ4QW3T.js";
import "./chunk-C7DRJMVZ.js";
import "./chunk-76TUGLCJ.js";
import {
  selectSvgElement
} from "./chunk-F5UA5DAB.js";
import "./chunk-XJRYD23X.js";
import {
  configureSvgSize
} from "./chunk-DIUA5PDQ.js";
import {
  __name,
  log
} from "./chunk-JZJEV6ER.js";
import "./chunk-SGZ3JTF4.js";
import "./chunk-ZSPGELVN.js";
import "./chunk-YNBBAPQR.js";

// node_modules/mermaid/dist/chunks/mermaid.core/infoDiagram-LFFYTUFH.mjs
var parser = {
  parse: __name(async (input) => {
    const ast = await parse("info", input);
    log.debug(ast);
  }, "parse")
};
var DEFAULT_INFO_DB = {
  version: "11.13.0" + (true ? "" : "-tiny")
};
var getVersion = __name(() => DEFAULT_INFO_DB.version, "getVersion");
var db = {
  getVersion
};
var draw = __name((text, id, version) => {
  log.debug("rendering info diagram\n" + text);
  const svg = selectSvgElement(id);
  configureSvgSize(svg, 100, 400, true);
  const group = svg.append("g");
  group.append("text").attr("x", 100).attr("y", 40).attr("class", "version").attr("font-size", 32).style("text-anchor", "middle").text(`v${version}`);
}, "draw");
var renderer = { draw };
var diagram = {
  parser,
  db,
  renderer
};
export {
  diagram
};
//# sourceMappingURL=infoDiagram-LFFYTUFH-S2MZTZV4.js.map

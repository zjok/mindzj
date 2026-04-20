import {
  parse
} from "./chunk-7WFNLDSV.js";
import "./chunk-5Y636TRJ.js";
import "./chunk-66KSN3MS.js";
import "./chunk-KFKJCP7S.js";
import "./chunk-RSKM5NQ4.js";
import "./chunk-TAS4BZCU.js";
import "./chunk-QQ5H4Y72.js";
import "./chunk-6OSIMNAA.js";
import "./chunk-3KX6U36Q.js";
import "./chunk-K7WKPLDJ.js";
import {
  selectSvgElement
} from "./chunk-F5UA5DAB.js";
import {
  configureSvgSize
} from "./chunk-DIUA5PDQ.js";
import {
  __name,
  log
} from "./chunk-JZJEV6ER.js";
import "./chunk-XHPT6X5E.js";
import "./chunk-AHDI4WSU.js";
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
//# sourceMappingURL=infoDiagram-LFFYTUFH-2ATTLRXH.js.map

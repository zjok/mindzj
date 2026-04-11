import {
  insertEdge,
  insertEdgeLabel,
  markers_default,
  positionEdgeLabel
} from "./chunk-RTD4DIZ5.js";
import {
  insertCluster,
  insertNode,
  labelHelper
} from "./chunk-X6WKFYZD.js";
import {
  interpolateToCurve
} from "./chunk-SVEWGH7X.js";
import {
  common_default,
  getConfig
} from "./chunk-DIUA5PDQ.js";
import {
  __name,
  log
} from "./chunk-JZJEV6ER.js";

// node_modules/mermaid/dist/chunks/mermaid.core/chunk-GLR3WWYH.mjs
var internalHelpers = {
  common: common_default,
  getConfig,
  insertCluster,
  insertEdge,
  insertEdgeLabel,
  insertMarkers: markers_default,
  insertNode,
  interpolateToCurve,
  labelHelper,
  log,
  positionEdgeLabel
};
var layoutAlgorithms = {};
var registerLayoutLoaders = __name((loaders) => {
  for (const loader of loaders) {
    layoutAlgorithms[loader.name] = loader;
  }
}, "registerLayoutLoaders");
var registerDefaultLayoutLoaders = __name(() => {
  registerLayoutLoaders([
    {
      name: "dagre",
      loader: __name(async () => await import("./dagre-KLK3FWXG-B4NQFK7F.js"), "loader")
    },
    ...true ? [
      {
        name: "cose-bilkent",
        loader: __name(async () => await import("./cose-bilkent-S5V4N54A-UTRG7ERQ.js"), "loader")
      }
    ] : []
  ]);
}, "registerDefaultLayoutLoaders");
registerDefaultLayoutLoaders();
var render = __name(async (data4Layout, svg) => {
  if (!(data4Layout.layoutAlgorithm in layoutAlgorithms)) {
    throw new Error(`Unknown layout algorithm: ${data4Layout.layoutAlgorithm}`);
  }
  const layoutDefinition = layoutAlgorithms[data4Layout.layoutAlgorithm];
  const layoutRenderer = await layoutDefinition.loader();
  return layoutRenderer.render(data4Layout, svg, internalHelpers, {
    algorithm: layoutDefinition.algorithm
  });
}, "render");
var getRegisteredLayoutAlgorithm = __name((algorithm = "", { fallback = "dagre" } = {}) => {
  if (algorithm in layoutAlgorithms) {
    return algorithm;
  }
  if (fallback in layoutAlgorithms) {
    log.warn(`Layout algorithm ${algorithm} is not registered. Using ${fallback} as fallback.`);
    return fallback;
  }
  throw new Error(`Both layout algorithms ${algorithm} and ${fallback} are not registered.`);
}, "getRegisteredLayoutAlgorithm");

export {
  registerLayoutLoaders,
  render,
  getRegisteredLayoutAlgorithm
};
//# sourceMappingURL=chunk-4O2MZXCF.js.map

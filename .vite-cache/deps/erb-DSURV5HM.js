import {
  ruby_default
} from "./chunk-7XBPUHDF.js";
import "./chunk-JWYMZ3MV.js";
import "./chunk-H5UZ6PFI.js";
import "./chunk-QCOY2NHU.js";
import "./chunk-WIT6YI5E.js";
import "./chunk-VF2I67BM.js";
import "./chunk-INERYMQ7.js";
import "./chunk-HWR55JQJ.js";
import "./chunk-QFUS4GDT.js";
import "./chunk-FSH2FPPF.js";
import "./chunk-AC4PASZA.js";
import "./chunk-IXFX7PWJ.js";
import "./chunk-PRB3R4HT.js";
import "./chunk-2TFNXKOW.js";
import "./chunk-XBGL5LQA.js";
import "./chunk-HIVTAIOI.js";
import {
  html_default
} from "./chunk-VHLLZ3CF.js";
import "./chunk-NV2PWELF.js";
import "./chunk-TVUBIVRU.js";
import "./chunk-YNBBAPQR.js";

// node_modules/@shikijs/langs/dist/erb.mjs
var lang = Object.freeze(JSON.parse('{"displayName":"ERB","fileTypes":["erb","rhtml","html.erb"],"injections":{"text.html.erb - (meta.embedded.block.erb | meta.embedded.line.erb | comment)":{"patterns":[{"begin":"(^\\\\s*)(?=<%+#(?![^%]*%>))","beginCaptures":{"0":{"name":"punctuation.whitespace.comment.leading.erb"}},"end":"(?!\\\\G)(\\\\s*$\\\\n)?","endCaptures":{"0":{"name":"punctuation.whitespace.comment.trailing.erb"}},"patterns":[{"include":"#comment"}]},{"begin":"(^\\\\s*)(?=<%(?![^%]*%>))","beginCaptures":{"0":{"name":"punctuation.whitespace.embedded.leading.erb"}},"end":"(?!\\\\G)(\\\\s*$\\\\n)?","endCaptures":{"0":{"name":"punctuation.whitespace.embedded.trailing.erb"}},"patterns":[{"include":"#tags"}]},{"include":"#comment"},{"include":"#tags"}]}},"name":"erb","patterns":[{"include":"text.html.basic"}],"repository":{"comment":{"patterns":[{"begin":"<%+#","beginCaptures":{"0":{"name":"punctuation.definition.comment.begin.erb"}},"end":"%>","endCaptures":{"0":{"name":"punctuation.definition.comment.end.erb"}},"name":"comment.block.erb"}]},"tags":{"patterns":[{"begin":"<%+(?!>)[-=]?(?![^%]*%>)","beginCaptures":{"0":{"name":"punctuation.section.embedded.begin.erb"}},"contentName":"source.ruby","end":"(-?%)>","endCaptures":{"0":{"name":"punctuation.section.embedded.end.erb"},"1":{"name":"source.ruby"}},"name":"meta.embedded.block.erb","patterns":[{"captures":{"1":{"name":"punctuation.definition.comment.erb"}},"match":"(#).*?(?=-?%>)","name":"comment.line.number-sign.erb"},{"include":"source.ruby"}]},{"begin":"<%+(?!>)[-=]?","beginCaptures":{"0":{"name":"punctuation.section.embedded.begin.erb"}},"contentName":"source.ruby","end":"(-?%)>","endCaptures":{"0":{"name":"punctuation.section.embedded.end.erb"},"1":{"name":"source.ruby"}},"name":"meta.embedded.line.erb","patterns":[{"captures":{"1":{"name":"punctuation.definition.comment.erb"}},"match":"(#).*?(?=-?%>)","name":"comment.line.number-sign.erb"},{"include":"source.ruby"}]}]}},"scopeName":"text.html.erb","embeddedLangs":["html","ruby"]}'));
var erb_default = [
  ...html_default,
  ...ruby_default,
  lang
];
export {
  erb_default as default
};
//# sourceMappingURL=erb-DSURV5HM.js.map

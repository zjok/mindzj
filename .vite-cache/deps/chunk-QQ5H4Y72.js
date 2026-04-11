import {
  AbstractMermaidTokenBuilder,
  CommonValueConverter,
  EmptyFileSystem,
  MermaidGeneratedSharedModule,
  PacketGrammarGeneratedModule,
  __name,
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  inject,
  lib_exports
} from "./chunk-3KX6U36Q.js";

// node_modules/@mermaid-js/parser/dist/chunks/mermaid-parser.core/chunk-C72U2L5F.mjs
var _a;
var PacketTokenBuilder = (_a = class extends AbstractMermaidTokenBuilder {
  constructor() {
    super(["packet"]);
  }
}, __name(_a, "PacketTokenBuilder"), _a);
var PacketModule = {
  parser: {
    TokenBuilder: __name(() => new PacketTokenBuilder(), "TokenBuilder"),
    ValueConverter: __name(() => new CommonValueConverter(), "ValueConverter")
  }
};
function createPacketServices(context = EmptyFileSystem) {
  const shared = inject(
    createDefaultSharedCoreModule(context),
    MermaidGeneratedSharedModule
  );
  const Packet = inject(
    createDefaultCoreModule({ shared }),
    PacketGrammarGeneratedModule,
    PacketModule
  );
  shared.ServiceRegistry.register(Packet);
  return { shared, Packet };
}
__name(createPacketServices, "createPacketServices");

export {
  PacketModule,
  createPacketServices
};
//# sourceMappingURL=chunk-QQ5H4Y72.js.map

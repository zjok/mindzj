export interface MindzjNode {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: MindzjNode[];
  isRoot?: boolean;
  side?: string;
  [key: string]: unknown;
}

export interface MindzjDocument {
  rootNodes: MindzjNode[];
  [key: string]: unknown;
}

export interface MindzjNodeMatch {
  node: MindzjNode;
  parent: MindzjNode | null;
  index: number;
  path: string[];
}

export interface MindzjNodeSummary {
  id: string;
  text: string;
  path: string[];
  side?: string;
  children: MindzjNodeSummary[];
}

export type MindzjTextPathInput = string | string[] | null | undefined;

const DEFAULT_ROOT_TEXT = "Root";

function randomId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  return cryptoRef?.randomUUID?.() ?? `mindzj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function estimateNodeSize(text: string, isRoot: boolean): { width: number; height: number } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const longest = Math.max(1, ...lines.map(charCount));
  return {
    width: clamp(longest * 8 + 28, isRoot ? 96 : 60, isRoot ? 360 : 320),
    height: Math.max(isRoot ? 40 : 32, lines.length * 22 + 12),
  };
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function measureIndent(value: string): number {
  let columns = 0;
  for (const char of value) {
    if (char === "\t") columns += 2;
    else if (char === " ") columns += 1;
    else break;
  }
  return columns;
}

function createNode(text: string, options?: { isRoot?: boolean; side?: string; x?: number; y?: number }): MindzjNode {
  const cleanText = stripInlineMarkdown(text) || (options?.isRoot ? DEFAULT_ROOT_TEXT : "Node");
  const size = estimateNodeSize(cleanText, !!options?.isRoot);
  const node: MindzjNode = {
    id: randomId(),
    text: cleanText,
    x: options?.x ?? 0,
    y: options?.y ?? 0,
    width: size.width,
    height: size.height,
    children: [],
  };
  if (options?.isRoot) node.isRoot = true;
  if (options?.side) node.side = options.side;
  return node;
}

function normalizeNode(raw: unknown, isRoot: boolean, seenIds: Set<string>): MindzjNode {
  const source = raw && typeof raw === "object" ? raw as Partial<MindzjNode> : {};
  const text = typeof source.text === "string" && source.text.trim()
    ? source.text.trim()
    : isRoot ? DEFAULT_ROOT_TEXT : "Node";
  let id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : randomId();
  if (seenIds.has(id)) id = randomId();
  seenIds.add(id);
  const size = estimateNodeSize(text, isRoot);
  const children = Array.isArray(source.children)
    ? source.children.map((child) => normalizeNode(child, false, seenIds))
    : [];
  const next: MindzjNode = {
    ...source,
    id,
    text,
    x: typeof source.x === "number" ? source.x : 0,
    y: typeof source.y === "number" ? source.y : 0,
    width: typeof source.width === "number" && source.width > 0 ? source.width : size.width,
    height: typeof source.height === "number" && source.height > 0 ? source.height : size.height,
    children,
  };
  if (isRoot) next.isRoot = true;
  return next;
}

export function parseMindzjDocument(content: string): MindzjDocument {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(content);
    if (value && typeof value === "object") parsed = value;
  } catch {
    parsed = {};
  }
  const rootNodes = Array.isArray(parsed.rootNodes) ? parsed.rootNodes : [];
  const seenIds = new Set<string>();
  const normalizedRoots = rootNodes.length
    ? rootNodes.map((node, index) => {
        const normalized = normalizeNode(node, true, seenIds);
        normalized.y = typeof normalized.y === "number" ? normalized.y : index * 200;
        return normalized;
      })
    : [createNode(DEFAULT_ROOT_TEXT, { isRoot: true })];
  return {
    ...parsed,
    rootNodes: normalizedRoots,
  };
}

export function serializeMindzjDocument(document: MindzjDocument): string {
  const normalized = parseMindzjDocument(JSON.stringify(document));
  return JSON.stringify(normalized, null, 2);
}

function appendNode(stack: Array<{ depth: number; node: MindzjNode }>, rootNodes: MindzjNode[], node: MindzjNode, depth: number) {
  while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
  const parent = stack[stack.length - 1]?.node;
  if (parent) parent.children.push(node);
  else {
    node.isRoot = true;
    if (!rootNodes.includes(node)) rootNodes.push(node);
  }
  stack.push({ depth, node });
}

export function mindzjDocumentFromMarkdown(markdown: string, options?: { rootTitle?: string }): MindzjDocument {
  const rootNodes: MindzjNode[] = [];
  const stack: Array<{ depth: number; node: MindzjNode }> = [];
  let currentRoot: MindzjNode | null = null;
  let inFence = false;
  let listBaseDepth = 1;
  let previousWasList = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^```|^~~~/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;

    const heading = rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = stripInlineMarkdown(heading[2]);
      if (!text) continue;
      if (level === 1 || !currentRoot) {
        currentRoot = createNode(text, { isRoot: true, y: rootNodes.length * 200 });
        rootNodes.push(currentRoot);
        stack.length = 0;
        stack.push({ depth: 0, node: currentRoot });
        previousWasList = false;
        continue;
      }
      const node = createNode(text, { side: "right" });
      appendNode(stack, rootNodes, node, Math.min(level - 1, 5));
      previousWasList = false;
      continue;
    }

    const leading = rawLine.match(/^\s*/)?.[0] ?? "";
    const indentLevel = Math.floor(measureIndent(leading) / 2);
    const left = rawLine.match(/^\s*\/\s+(.+)$/);
    const list = rawLine.match(/^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s+(.+)$/);
    const task = rawLine.match(/^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/);
    const listText = stripInlineMarkdown(task?.[1] ?? list?.[1] ?? left?.[1] ?? "");

    if (listText) {
      if (!currentRoot) {
        currentRoot = createNode(options?.rootTitle || DEFAULT_ROOT_TEXT, { isRoot: true });
        rootNodes.push(currentRoot);
        stack.length = 0;
        stack.push({ depth: 0, node: currentRoot });
      }
      if (!previousWasList) {
        listBaseDepth = (stack[stack.length - 1]?.depth ?? 0) + 1;
      }
      const node = createNode(listText, { side: left ? "left" : "right" });
      appendNode(stack, rootNodes, node, listBaseDepth + indentLevel);
      previousWasList = true;
      continue;
    }

    const paragraphText = stripInlineMarkdown(trimmed);
    if (!paragraphText) continue;
    if (!currentRoot) {
      currentRoot = createNode(paragraphText, { isRoot: true, y: rootNodes.length * 200 });
      rootNodes.push(currentRoot);
      stack.length = 0;
      stack.push({ depth: 0, node: currentRoot });
      previousWasList = false;
    } else {
      const node = createNode(paragraphText, { side: "right" });
      appendNode(stack, rootNodes, node, stack[stack.length - 1]?.depth + 1 || 1);
      previousWasList = false;
    }
  }

  if (!rootNodes.length) {
    rootNodes.push(createNode(options?.rootTitle || DEFAULT_ROOT_TEXT, { isRoot: true }));
  }
  return { rootNodes };
}

export function summarizeMindzjDocument(document: MindzjDocument): MindzjNodeSummary[] {
  const visit = (node: MindzjNode, path: string[]): MindzjNodeSummary => {
    const nextPath = [...path, node.text];
    return {
      id: node.id,
      text: node.text,
      path: nextPath,
      ...(node.side ? { side: node.side } : {}),
      children: node.children.map((child) => visit(child, nextPath)),
    };
  };
  return document.rootNodes.map((root) => visit(root, []));
}

export function flattenMindzjNodes(document: MindzjDocument): MindzjNodeMatch[] {
  const result: MindzjNodeMatch[] = [];
  const visit = (node: MindzjNode, parent: MindzjNode | null, index: number, path: string[]) => {
    const nextPath = [...path, node.text];
    result.push({ node, parent, index, path: nextPath });
    node.children.forEach((child, childIndex) => visit(child, node, childIndex, nextPath));
  };
  document.rootNodes.forEach((root, index) => visit(root, null, index, []));
  return result;
}

function normalizeTextPath(path: MindzjTextPathInput): string[] {
  if (Array.isArray(path)) return path.map((item) => String(item).trim()).filter(Boolean);
  if (typeof path !== "string") return [];
  return path
    .split(/(?:\s*>\s*|\s*\/\s*)/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function findMindzjNode(
  document: MindzjDocument,
  reference: { nodeId?: string | null; textPath?: MindzjTextPathInput; text?: string | null },
): MindzjNodeMatch | null {
  const flat = flattenMindzjNodes(document);
  const nodeId = reference.nodeId?.trim();
  if (nodeId) return flat.find((match) => match.node.id === nodeId) ?? null;

  const textPath = normalizeTextPath(reference.textPath);
  if (textPath.length) {
    return flat.find((match) =>
      match.path.length === textPath.length &&
      match.path.every((part, index) => sameText(part, textPath[index])),
    ) ?? null;
  }

  const text = reference.text?.trim();
  if (!text) return null;
  const matches = flat.filter((match) => sameText(match.node.text, text));
  return matches.length === 1 ? matches[0] : null;
}

export function addMindzjNode(
  document: MindzjDocument,
  input: {
    text: string;
    parentId?: string | null;
    parentTextPath?: MindzjTextPathInput;
    parentText?: string | null;
    index?: number | null;
    side?: string | null;
  },
): MindzjNodeMatch {
  const parent = findMindzjNode(document, {
    nodeId: input.parentId,
    textPath: input.parentTextPath,
    text: input.parentText,
  });
  const shouldCreateRoot = !parent && document.rootNodes.length !== 1;
  const node = createNode(input.text, {
    isRoot: shouldCreateRoot,
    side: shouldCreateRoot ? undefined : input.side || parent?.node.side || "right",
    y: shouldCreateRoot ? document.rootNodes.length * 200 : 0,
  });
  if (shouldCreateRoot) {
    document.rootNodes.push(node);
    return { node, parent: null, index: document.rootNodes.length - 1, path: [node.text] };
  }

  const parentNode = parent?.node ?? document.rootNodes[0];
  const index = typeof input.index === "number"
    ? clamp(Math.round(input.index), 0, parentNode.children.length)
    : parentNode.children.length;
  parentNode.children.splice(index, 0, node);
  return { node, parent: parentNode, index, path: [...(parent?.path ?? [parentNode.text]), node.text] };
}

export function updateMindzjNodeText(match: MindzjNodeMatch, text: string): MindzjNodeMatch {
  const cleanText = stripInlineMarkdown(text) || match.node.text;
  const size = estimateNodeSize(cleanText, !!match.node.isRoot);
  match.node.text = cleanText;
  match.node.width = size.width;
  match.node.height = size.height;
  return {
    ...match,
    path: [...match.path.slice(0, -1), cleanText],
  };
}

export function deleteMindzjNode(document: MindzjDocument, match: MindzjNodeMatch, allowDeleteRoot = false): MindzjNodeMatch {
  if (!match.parent) {
    if (document.rootNodes.length <= 1) throw new Error("Refusing to delete the only root node.");
    if (!allowDeleteRoot) throw new Error("Refusing to delete a root node without allow_delete_root.");
    document.rootNodes.splice(match.index, 1);
    return match;
  }
  match.parent.children.splice(match.index, 1);
  return match;
}

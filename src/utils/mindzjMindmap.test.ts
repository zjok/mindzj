import { describe, expect, it } from "vitest";
import {
  addMindzjNode,
  deleteMindzjNode,
  findMindzjNode,
  mindzjDocumentFromMarkdown,
  updateMindzjNodeText,
} from "./mindzjMindmap";

describe("mindzjMindmap", () => {
  it("converts markdown headings and nested lists into mind map nodes", () => {
    const document = mindzjDocumentFromMarkdown([
      "# Project",
      "## Goals",
      "- Ship AI tools",
      "  - Mind map support",
      "## Risks",
    ].join("\n"));

    expect(document.rootNodes).toHaveLength(1);
    expect(document.rootNodes[0].text).toBe("Project");
    expect(document.rootNodes[0].children.map((node) => node.text)).toEqual(["Goals", "Risks"]);
    expect(document.rootNodes[0].children[0].children[0].text).toBe("Ship AI tools");
    expect(document.rootNodes[0].children[0].children[0].children[0].text).toBe("Mind map support");
  });

  it("adds, updates, and deletes nodes by text path", () => {
    const document = mindzjDocumentFromMarkdown("# Project\n## Goals");
    const added = addMindzjNode(document, {
      parentTextPath: ["Project", "Goals"],
      text: "Draft",
    });
    expect(added.path).toEqual(["Project", "Goals", "Draft"]);

    const match = findMindzjNode(document, { textPath: ["Project", "Goals", "Draft"] });
    expect(match).not.toBeNull();
    const updated = updateMindzjNodeText(match!, "Publish");
    expect(updated.path).toEqual(["Project", "Goals", "Publish"]);

    const deleteTarget = findMindzjNode(document, { textPath: ["Project", "Goals", "Publish"] });
    expect(deleteTarget).not.toBeNull();
    deleteMindzjNode(document, deleteTarget!);
    expect(findMindzjNode(document, { textPath: ["Project", "Goals", "Publish"] })).toBeNull();
  });
});


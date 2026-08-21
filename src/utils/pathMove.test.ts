import { describe, expect, it } from "vitest";
import { remapMovedPath, remapUniquePathItems } from "./pathMove";

describe("path move state migration", () => {
  it("moves an open file to its new path", () => {
    expect(remapMovedPath("inbox/note.md", "inbox/note.md", "work/note.md"))
      .toBe("work/note.md");
  });

  it("moves open files below a moved folder", () => {
    expect(remapMovedPath("old/a/note.md", "old", "archive/old", true))
      .toBe("archive/old/a/note.md");
    expect(remapMovedPath("older/note.md", "old", "archive/old", true))
      .toBe("older/note.md");
  });

  it("keeps the moved tab unique and preserves its content", () => {
    const tabs = remapUniquePathItems(
      [
        { path: "target/note.md", content: "stale destination" },
        { path: "source/note.md", content: "latest source content" },
      ],
      "source/note.md",
      "target/note.md",
    );

    expect(tabs).toEqual([
      { path: "target/note.md", content: "latest source content" },
    ]);
  });
});

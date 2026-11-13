import { expect, test } from "bun:test";
import { imageLinks } from "./image-links.ts";

test("image paths in a terminal line", () => {
  for (
    const [line, expected] of [
      ["see /home/me/shot.png now", [{ path: "/home/me/shot.png", start: 4, end: 21 }]],
      ["file:///home/me/my%20shot.PNG", [{ path: "/home/me/my shot.PNG", start: 0, end: 29 }]],
      ["~/Pictures/a.jpeg, /tmp/b.webp", [
        { path: "~/Pictures/a.jpeg", start: 0, end: 17 },
        { path: "/tmp/b.webp", start: 19, end: 30 },
      ]],
      ["'/tmp/q.gif'", [{ path: "/tmp/q.gif", start: 1, end: 11 }]],
      // relative paths, other files and look-alike suffixes are not links
      ["./shot.png src/logo.svg", []],
      ["/tmp/notes.txt /tmp/a.png.bak", []],
      ["https://example.com/a.png", []],
    ] as const
  ) {
    expect(imageLinks(line)).toEqual(expected as never);
  }
});

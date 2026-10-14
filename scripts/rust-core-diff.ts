// DESCRIPTION Replay existing TypeScript fixtures and copied pages against Rust JSON operations.
// USAGE deno test -A --config app/deno.json scripts/rust-core-diff.ts [-- corpus.json]
// EXAMPLES deno test -A --unsafe-proto --config app/deno.json scripts/rust-core-diff.ts -- --wasm
import * as markdown from "../core/page-markdown.ts";
import * as marks from "../core/todo-marks.ts";
import { mergePageBlocks } from "../core/page-merge.ts";

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const wasm = Deno.args.includes("--wasm");
const mode = wasm ? "wasm" : "native";
if ((({} as Record<string, unknown>).__proto__ !== undefined) !== wasm) {
  throw new Error(
    wasm
      ? "Wasm replay requires --unsafe-proto to model browser semantics"
      : "Native replay requires Deno's default prototype semantics",
  );
}
const dir = `${root}/.scratch/stage0/core-${mode}-fixtures`;
await Deno.mkdir(dir, { recursive: true });
const modules = {
  "page-markdown": markdown,
  "page-merge": { mergePageBlocks },
  "todo-marks": marks,
};
const proxySource = `
import * as markdown from ${JSON.stringify(`${root}/core/page-markdown.ts`)};
import * as merge from ${JSON.stringify(`${root}/core/page-merge.ts`)};
import * as marks from ${JSON.stringify(`${root}/core/todo-marks.ts`)};
export type { PageBlock, PageTextBlock, PageFolderBlock, PageEmbedBlock, FolderView } from ${
  JSON.stringify(`${root}/core/page-markdown.ts`)
};
export type { Marks } from ${JSON.stringify(`${root}/core/todo-marks.ts`)};
export const cases: { request: unknown; expected: unknown }[] = [];
function invoke(op: string, fn: (...args: any[]) => any, args: any[]) {
  const result = fn(...args);
  let input = args;
  if (op === "stampTodoMarks" && input[1] === undefined) input = [input[0], marks.todayMark()];
  if (op === "todayMark") {
    const d = input[0] ?? new Date();
    input = [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  }
  const request: Record<string, unknown> = { op, args: input };
  if (op === "markdownToPageBlocks") request.ids = result.map((b: { id: string }) => b.id);
  cases.push(structuredClone({ request, expected: result }));
  return result;
}
${
  Object.entries(modules).flatMap(([module, exports]) =>
    Object.keys(exports).map((name) => {
      const alias = module === "page-markdown"
        ? "markdown"
        : module === "page-merge"
        ? "merge"
        : "marks";
      return typeof exports[name as keyof typeof exports] === "function"
        ? `export const ${name}: typeof ${alias}.${name} = (...args: any[]) => invoke(${
          JSON.stringify(name)
        }, ${alias}.${name}, args);`
        : `export const ${name} = ${alias}.${name};`;
    })
  ).join("\n")
}
`;
await Deno.writeTextFile(`${dir}/proxy.ts`, proxySource);
for (const name of ["page_markdown", "page_merge", "todo_marks"]) {
  const source = (await Deno.readTextFile(`${root}/app/${name}_test.ts`))
    .replaceAll(
      /"\.\.\/core\/(?:page-markdown|page-merge|todo-marks)\.ts"/g,
      '"./proxy.ts"',
    );
  const file = `${dir}/${name}_test.ts`;
  await Deno.writeTextFile(file, source);
  await import(`file://${file}`);
}
const proxy = await import(`file://${dir}/proxy.ts`);

Deno.test(`Rust ${mode} reproduces every existing fixture operation and copied page`, async () => {
  const corpusPath = Deno.args.find((arg) => arg !== "--wasm") ??
    `${root}/.scratch/stage0/pages.json`;
  const pages = JSON.parse(Deno.readTextFileSync(corpusPath));
  let pageCount = 0;
  let blockCount = 0;
  for (const page of pages) {
    const content = typeof page.content === "string"
      ? JSON.parse(page.content)
      : page.content;
    const blocks = Array.isArray(content) ? content : content?.blocks;
    if (!Array.isArray(blocks)) {
      throw new Error("copied page content must contain blocks");
    }
    pageCount++;
    blockCount += blocks.length;
    const rendered = proxy.pageBlocksToMarkdown(blocks);
    const next = proxy.markdownToPageBlocks(rendered, page.title ?? "");
    proxy.mergePageBlocks(blocks, next);
    proxy.stampTodoMarks(blocks, "2026-10-10");
    for (const b of blocks) {
      if (typeof b?.text !== "string") continue;
      proxy.readMarks(b.text);
      proxy.stripMarks(b.text);
      proxy.normalizeMarks(b.text);
      proxy.touchTodo(b.text, "2026-10-10");
      proxy.carryMarks(b.text, proxy.stripMarks(b.text));
    }
  }
  for (
    const text of [
      "\u0085# NEL",
      "\ufeff# BOM",
      "# title\u2028suffix",
      "- [ ] x\u2029suffix",
      "- [ ] x\u2028",
      "- [ ] x\u2029",
      "{{trame:constructor=x}} {{trame:__proto__=y}}",
      "{{trame:z=1}} {{trame:due=2}} {{trame:a=3}}",
      "{{trame:updated_at=😀,\ue000,a}}",
      "\r\n# Title\r- [X] task\r",
    ]
  ) {
    proxy.markdownToPageBlocks(text, "Title");
    proxy.readMarks(text);
    proxy.stripMarks(text);
    proxy.normalizeMarks(text);
    proxy.touchTodo(text, "2026-10-10");
  }
  const input = `${dir}/requests.jsonl`;
  Deno.writeTextFileSync(
    input,
    proxy.cases.map((c: { request: unknown }) => JSON.stringify(c.request))
      .join("\n") + "\n",
  );
  Deno.writeTextFileSync(
    `${dir}/expected.jsonl`,
    proxy.cases.map((c: { expected: unknown }) => JSON.stringify(c.expected))
      .join("\n") + "\n",
  );
  let outputs: string[];
  if (wasm) {
    const binding = await import(
      `file://${root}/.scratch/stage0/wasm/trame_core.js`
    );
    binding.initSync({
      module: Deno.readFileSync(
        `${root}/.scratch/stage0/wasm/trame_core_bg.wasm`,
      ),
    });
    outputs = proxy.cases.map((c: { request: unknown }) =>
      binding.evaluate(JSON.stringify(c.request))
    );
    const fresh = JSON.parse(
      binding.evaluate(
        JSON.stringify({
          op: "markdownToPageBlocks",
          args: ["- [ ] wasm crypto"],
        }),
      ),
    );
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(fresh[0].id)
    ) {
      throw new Error("Wasm browser crypto UUID binding failed");
    }
  } else {
    const result = new Deno.Command(`${root}/target/debug/rust-core`, {
      args: [input],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!result.success) {
      throw new Error(
        `Rust process failed: ${new TextDecoder().decode(result.stderr)}`,
      );
    }
    outputs = new TextDecoder().decode(result.stdout).trimEnd().split("\n");
  }
  if (outputs.length !== proxy.cases.length) {
    throw new Error("Rust output count differs");
  }
  for (let i = 0; i < outputs.length; i++) {
    if (outputs[i] !== JSON.stringify(proxy.cases[i].expected)) {
      throw new Error(
        `Rust differs at case ${i}, operation ${
          proxy.cases[i].request.op
        }; private inputs and outputs omitted`,
      );
    }
  }
  Deno.writeTextFileSync(
    `${root}/.scratch/stage0/core-${mode}-differential-summary.json`,
    JSON.stringify(
      {
        mode,
        pageCount,
        blockCount,
        operations: proxy.cases.length,
        byteIdentical: true,
        originalAssertionsUnchanged: true,
        prototypeSemantics: wasm
          ? "browser Object.prototype (Deno --unsafe-proto)"
          : "default Deno",
        realBrowserVerified: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Byte-identical Rust ${mode} outputs: ${proxy.cases.length} operations, ${pageCount} copied pages, ${blockCount} blocks`,
  );
});

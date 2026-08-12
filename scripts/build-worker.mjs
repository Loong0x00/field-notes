import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

async function htmlPages(directory, relative = "") {
  const pages = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const item = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(pages, await htmlPages(directory, item));
    if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
    const normalized = item.split(path.sep).join("/");
    const urlPath = normalized === "index.html"
      ? "/"
      : normalized.endsWith("/index.html")
        ? `/${normalized.slice(0, -"index.html".length)}`
        : `/${normalized}`;
    pages[urlPath] = await readFile(path.join(directory, item), "utf8");
  }
  return pages;
}

await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await cp("public", "dist/client", { recursive: true });
const pages = await htmlPages("public");
for (const urlPath of Object.keys(pages)) {
  const relative = urlPath === "/"
    ? "index.html"
    : urlPath.endsWith("/")
      ? `${urlPath.slice(1)}index.html`
      : urlPath.slice(1);
  await rm(path.join("dist/client", relative));
}

await build({
  entryPoints: ["worker/index.js"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  define: { __STATIC_HTML__: JSON.stringify(pages) },
  minify: false,
  sourcemap: false,
});

await mkdir("dist/.openai", { recursive: true });
await writeFile("dist/.openai/hosting.json", await readFile(".openai/hosting.json"));
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
console.log("built Cloudflare Worker and static assets into dist");

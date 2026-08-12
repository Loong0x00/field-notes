import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
await cp("public", "dist/client", { recursive: true });

await build({
  entryPoints: ["worker/index.js"],
  outfile: "dist/server/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
  sourcemap: false,
});

await mkdir("dist/.openai", { recursive: true });
await writeFile("dist/.openai/hosting.json", await readFile(".openai/hosting.json"));
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
console.log("built Cloudflare Worker and static assets into dist");

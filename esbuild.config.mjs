import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";

const production = process.argv[2] === "production";
const notices = await Promise.all(["cytoscape", "yaml"].map(async (name) => {
  const license = await readFile(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), "utf8");
  return `${name}\n${license.trim().replaceAll("*/", "* /")}`;
}));
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  banner: { js: `/*! Bundled library notices\n\n${notices.join("\n\n")}\n*/` },
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

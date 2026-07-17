import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "dist");
await mkdir(outputDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "web/intake-app.js")],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: ["es2022"],
});

const script = result.outputFiles[0].text;
const css = await readFile(path.join(root, "web/intake-app.css"), "utf8");
const logo = await readFile(path.join(root, "web/assets/rsg-logo.jpg"));
const brandedScript = script.replaceAll(
  "__RSG_LOGO_DATA_URL__",
  `data:image/jpeg;base64,${logo.toString("base64")}`,
);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>RSG Intake Gate</title>
  <style>${css}</style>
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script>${brandedScript}</script>
</body>
</html>\n`;

await writeFile(path.join(outputDir, "intake-app.html"), html, "utf8");

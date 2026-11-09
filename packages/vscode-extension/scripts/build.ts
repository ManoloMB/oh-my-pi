/**
 * Bundles the extension host (Node, CommonJS, `vscode` external) and the
 * webviews (browser ESM + CSS) into `dist/`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.join(root, "dist");
const production = !process.argv.includes("--dev");

await fs.rm(dist, { recursive: true, force: true });

const host = await Bun.build({
	entrypoints: [path.join(root, "src/extension.ts")],
	outdir: dist,
	target: "node",
	format: "cjs",
	external: ["vscode"],
	minify: production,
	sourcemap: production ? "none" : "linked",
});
if (!host.success) throw new AggregateError(host.logs, "extension host build failed");

const logo = await fs.readFile(path.join(root, "media", "maria-logo.png"));
const logoDataUrl = `data:image/png;base64,${logo.toString("base64")}`;
for (const view of ["chat", "settings"]) {
	const result = await Bun.build({
		entrypoints: [path.join(root, `webview/${view}/main.ts`)],
		outdir: path.join(dist, "webview"),
		naming: `${view}.js`,
		target: "browser",
		format: "esm",
		minify: production,
		sourcemap: production ? "none" : "inline",
		// The logo's goodbye draws it in WebGL, which refuses cross-origin images: it ships inline.
		define: { MARIA_LOGO_URL: JSON.stringify(logoDataUrl) },
	});
	if (!result.success) throw new AggregateError(result.logs, `${view} webview build failed`);
	await fs.copyFile(path.join(root, `webview/${view}/${view}.css`), path.join(dist, "webview", `${view}.css`));
}
for (const asset of ["maria-mark.png", "maria-logo.png"]) {
	await fs.copyFile(path.join(root, "media", asset), path.join(dist, "webview", asset));
}

console.log(`built ${path.relative(process.cwd(), dist)}`);

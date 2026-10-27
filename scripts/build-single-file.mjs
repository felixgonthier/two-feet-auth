// Builds the demo as one self-contained HTML file from the real sources (demo/, sdk/, core/, ui/, brand/).
// For places that only take a single file, like an embedded preview or an email attachment.
//
//   node scripts/build-single-file.mjs                 → dist/piggyback-demo.html (a full HTML document)
//   node scripts/build-single-file.mjs --fragment out  → page content without <html>/<head>/<body>, for hosts that add their own
//
// It's a tiny bundler for this repo's style of modules: named `import { a } from "./x.js"`, side-effect imports,
// and `export function|class|const name`. Each module runs in its own scope, in dependency order.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const fragment = args.includes("--fragment");
const out = path.resolve(args.find(a => !a.startsWith("--")) || path.join(ROOT, "dist", "piggyback-demo.html"));

const IMPORT = /^import\s*(?:\{([^}]*)\}\s*from\s*)?"([^"]+)";\s*$/gm;
const EXPORT = /^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

const modules = new Map(); // absolute path → { id, code, exports }
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const mod = { id: `__m${modules.size}`, file };
  modules.set(file, mod);
  let code = fs.readFileSync(file, "utf8");
  const deps = [];
  code = code.replace(IMPORT, (_, names, spec) => {
    const dep = load(path.resolve(path.dirname(file), spec));
    deps.push(dep);
    return names ? `const {${names}} = ${dep.id};` : "";
  });
  mod.exports = [...code.matchAll(EXPORT)].map(m => m[1]);
  mod.code = code.replace(/^export\s+/gm, "");
  mod.deps = deps;
  return mod;
}
const order = [];
const visit = (m, seen = new Set()) => {
  if (seen.has(m)) return;
  seen.add(m);
  m.deps.forEach(d => visit(d, seen));
  if (!order.includes(m)) order.push(m);
};

// The sample camera is loaded on demand by the element; in a single file it's registered up front.
const sample = load(path.join(ROOT, "sdk/sample-camera.js"));
const entry = load(path.join(ROOT, "demo/app.js"));
visit(sample);
visit(entry);
const bundle = order.map(m => `// ---- ${path.relative(ROOT, m.file)} ----
const ${m.id} = (() => {
${m.code}
return { ${m.exports.join(", ")} };
})();`).join("\n\n") + `\nglobalThis.PiggybackSample = ${sample.id};`;

let html = fs.readFileSync(path.join(ROOT, "demo/index.html"), "utf8");
const dataUri = f => `data:image/${f.endsWith(".png") ? "png" : "svg+xml"};base64,${fs.readFileSync(path.join(ROOT, f)).toString("base64")}`;
html = html
  .replace(/<link rel="stylesheet" href="\.\.\/(ui|brand)\/([\w.-]+\.css)">/g, (_, dir, f) => `<style>\n${fs.readFileSync(path.join(ROOT, dir, f), "utf8")}</style>`)
  .replace(/(src|href)="\.\.\/brand\/([\w.-]+\.(?:svg|png))"/g, (_, attr, f) => `${attr}="${dataUri(`brand/${f}`)}"`)
  // The bundle registers the sample camera before the demo starts, so it has to run before the element mounts.
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/, () => `<script>\n(() => {\n"use strict";\n${bundle.replace(/<\/script/gi, "<\\/script")}\n})();\n</script>`);

if (fragment) {
  const head = html.slice(html.indexOf("<head>") + 6, html.indexOf("</head>"));
  // The host supplies <body>, so its classes move to a wrapper.
  const open = html.match(/<body([^>]*)>/);
  const body = html.slice(open.index + open[0].length, html.indexOf("</body>"));
  const cls = open[1].match(/class="([^"]*)"/)?.[1];
  const keep = head.match(/<title>[\s\S]*?<\/title>|<link rel="icon"[^>]*>|<style>[\s\S]*?<\/style>/g) || [];
  html = `${keep.join("\n")}\n${cls ? `<div class="${cls}" style="min-height:100vh">\n${body.trim()}\n</div>` : body.trim()}\n`;
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${path.relative(process.cwd(), out)}  ${(html.length / 1024).toFixed(0)} KB  (${order.length} modules)`);

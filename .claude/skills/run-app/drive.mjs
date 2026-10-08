// Runs a snippet against the git-ai window over CDP.
// usage: node drive.mjs <snippet.js> [shot.png]
// The snippet is the body of an async function(page); its return value is printed.
import { chromium } from "playwright-core";
import { readFileSync } from "fs";
const [, , snip, shot] = process.argv;
const b = await chromium.connectOverCDP("http://localhost:9222");
const page = b.contexts()[0].pages()[0];
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
try {
  const fn = new Function("page", `return (async () => { ${readFileSync(snip, "utf8")} })()`);
  const r = await fn(page);
  if (r !== undefined) console.log(typeof r === "string" ? r : JSON.stringify(r, null, 1));
} catch (e) {
  console.log("ERR", e.message.split("\n")[0]);
}
await page.waitForTimeout(300);
if (shot) await page.screenshot({ path: shot });
if (errs.length) console.log("CONSOLE ERRORS:", errs.join("\n"));
process.exit(0);

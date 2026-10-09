import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

await esbuild.build({
  entryPoints: ["./src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  outfile: "./app.js",
});
console.log("dashboard app.js built");

// stage static files into ./static for embed
mkdirSync("./static", { recursive: true });
cpSync("./index.html", "./static/index.html");
cpSync("./app.js", "./static/app.js");
cpSync("./style.css", "./static/style.css");
console.log("dashboard static staged");

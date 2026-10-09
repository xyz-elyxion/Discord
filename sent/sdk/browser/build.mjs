// Builds the SDK into a standalone browser bundle (sdk.js).
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["./sdk.ts"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"], // Web Crypto + async/await only
  globalName: "__limeyGuardInternal",
  outfile: "./sdk.js",
  banner: {
    js: "/* Limey Guard browser SDK. Generated file. */\n",
  },
  footer: {
    js: 'window.LimeyGuard = { protect: __limeyGuardInternal.protect };\n',
  },
});
console.log("sdk.js built");

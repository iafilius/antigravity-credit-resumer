const esbuild = require("esbuild");

const args = process.argv.slice(2);
const minify = args.includes("--minify");
const watch = args.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: minify,
    sourcemap: !minify,
    platform: "node",
    target: "node16",
    outfile: "dist/extension.js",
    external: ["vscode"],
  });

  if (watch) {
    await ctx.watch();
    console.log("watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

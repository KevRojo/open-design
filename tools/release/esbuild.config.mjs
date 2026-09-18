import { build } from "esbuild";

await build({
  banner: {
    js: "#!/usr/bin/env node",
  },
  bundle: true,
  entryPoints: ["./src/index.ts"],
  external: ["sharp"],
  format: "esm",
  outfile: "./dist/index.mjs",
  platform: "node",
  target: "node24",
});

// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: true,
  target: "es2020",
  outDir: "dist",
  external: ["drizzle-orm"],
});
import sucrase from "@rollup/plugin-sucrase";
import resolve from "@rollup/plugin-node-resolve";
import { readdir } from "fs/promises";

const modules = await readdir("plugins");

/** @type {import("rollup").RollupOptions[]} */
export default modules.map((m) => ({
  input: `plugins/${m}/index.ts`,
  plugins: [
    resolve(),
    sucrase({ transforms: ["typescript"], disableESTransforms: true }),
  ],
  output: {
    file: `dist/${m}.js`,
    format: "iife",
    globals: {
      "@yuuza/mcloud": "mcloud",
      "@yuuza/webfx": "mcloud.webfx",
    },
  },
  external: ["@yuuza/mcloud", "@yuuza/webfx"],
}));

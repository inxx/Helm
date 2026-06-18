import { build } from "vite";
import config from "../vite.config.ts";

await build({
  ...config,
  configFile: false,
  root: process.cwd(),
});

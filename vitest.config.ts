import { basename, resolve } from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    setupFiles: ["test/setup.ts"],
    resolveSnapshotPath: (testPath, snapshotExtension) => {
      return resolve(__dirname, "test", "snapshots", `${basename(testPath)}${snapshotExtension}`);
    },
  },
});

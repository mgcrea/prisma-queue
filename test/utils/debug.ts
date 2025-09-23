import { writeSync } from "node:fs";
import { inspect } from "util";

declare global {
  var p: (s: string) => void;
  var d: (...args: unknown[]) => void;
  var dd: (...args: unknown[]) => void;
}

globalThis.p = (s: string) => {
  writeSync(1, `\n${s}`);
  // fsyncSync(1);
};
globalThis.d = (...args: unknown[]) => {
  p("🔴 " + inspect(args.length > 1 ? args : args[0], { colors: true, depth: 10 }) + "\n");
};
globalThis.dd = (...args: unknown[]) => {
  const error = new Error();
  globalThis.d(error);
  globalThis.d(...args);
  setImmediate(() => {
    process.exit(1);
  });
};

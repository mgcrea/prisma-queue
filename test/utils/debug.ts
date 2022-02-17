/* eslint-disable no-var */
import {inspect} from 'util';
import {log} from 'console';

declare global {
  var d: (...args: unknown[]) => void;
  var dd: (...args: unknown[]) => void;
}

globalThis.d = (...args: unknown[]) => {
  setImmediate(() => log('🔴 ' + inspect(args.length > 1 ? args : args[0], {colors: true, depth: 10}) + '\n'));
};
globalThis.dd = (...args: unknown[]) => {
  const error = new Error();
  globalThis.d(error);
  globalThis.d(...args);
  setImmediate(() => {
    process.exit(1);
  });
};

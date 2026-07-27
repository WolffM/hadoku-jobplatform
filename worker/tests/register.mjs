// Entry point for `node --import`. Registers the .js → .ts resolve hook that
// lets tests import worker source directly (see ts-resolve.mjs).
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);

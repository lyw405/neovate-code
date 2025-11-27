import { File } from 'node:buffer';

// Polyfill File for Node.js 18 compatibility
if (typeof globalThis.File === 'undefined') {
  (globalThis as any).File = File;
}

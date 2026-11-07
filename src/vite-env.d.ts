/// <reference types="vite/client" />

declare module 'sql.js/dist/sql-asm.js' {
  import type { SqlJsStatic } from 'sql.js';
  const initSqlJs: () => Promise<SqlJsStatic>;
  export default initSqlJs;
}

/** The app's version from package.json (set in vite.config.ts). */
declare const __APP_VERSION__: string;

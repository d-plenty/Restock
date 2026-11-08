/**
 * What the built app's files are called. Android's app packaging unpacks files ending in ".gz"
 * and drops the ending, so the receipt reader's English model (eng.traineddata.gz) went missing on
 * the phone ("Couldn't load the receipt reader (404)") until 0.8.7. Used by vite.config.ts.
 */
export function assetFileName(info: { names?: string[]; name?: string }): string {
  return (info.names?.[0] ?? info.name ?? '').endsWith('.gz') ? 'assets/[name]-[hash].gz.bin' : 'assets/[name]-[hash][extname]';
}

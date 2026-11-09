import { Capacitor } from '@capacitor/core';

export interface TextFile {
  name: string;
  text: string;
}

/**
 * Hand text files to the person: Android's share menu on the phone (all of them at once), a
 * download each in a browser. Written to the app's cache first, which Android clears by itself.
 */
export async function shareTextFiles(files: TextFile[], mime = 'application/json', title = files[0]?.name ?? 'Restock'): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const uris: string[] = [];
    for (const f of files) uris.push((await Filesystem.writeFile({ path: f.name, data: f.text, directory: Directory.Cache, encoding: Encoding.UTF8 })).uri);
    await Share.share({ title, files: uris });
    return;
  }
  for (const f of files) {
    const url = URL.createObjectURL(new Blob([f.text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    a.click();
    URL.revokeObjectURL(url);
  }
}

/** One text file, as shareTextFiles. */
export const shareTextFile = (name: string, text: string, mime = 'application/json', title = name): Promise<void> =>
  shareTextFiles([{ name, text }], mime, title);

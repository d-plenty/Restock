// The photo reader's model files as part of the build. Only the Restock server's web pages are built
// with these (vite.server.config.ts sets __READER_BUNDLED__): the server hands them out itself, so a
// browser never goes to GitHub for them. The phone and tablet apps download them on first use
// (lib/readerModels.ts) and leave this file out.
import detFile from '../../assets/reader/ppocrv5-mobile-det.onnx?url';
import recFile from '../../assets/reader/ppocrv5-mobile-rec.onnx?url';

export const det = detFile;
export const rec = recFile;

// 0.15.2: the privacy policy and the fine print as web pages, for the app stores (both need a
// privacy policy at a web address) and for anyone deciding whether to install Restock. Made from the
// same words the app shows (src/lib/legal.json), so the two never say different things.
//   node tools/legal-pages/make.mjs          writes docs/PRIVACY.md and docs/TERMS.md
//   node tools/legal-pages/make.mjs --check  fails if they're out of date (legalPages.test.ts runs it)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const legal = JSON.parse(readFileSync(join(root, 'src/lib/legal.json'), 'utf8'));

// Plain text: a "<shop>" in the app's words would be read as a tag on GitHub.
const para = (t) => t.trim().replace(/</g, '&lt;');
const list = (items) => items.map((t) => `- ${para(t)}`).join('\n');

export function page(doc, updated) {
  const out = [`# ${doc.title}`, '', `Restock · last updated ${updated}. This is the same as the app shows (Settings → Privacy and sharing).`, ''];
  if (doc.tagline) out.push(`_${doc.tagline}_`, '');
  if (doc.intro) out.push(para(doc.intro), '');
  if (doc.summary?.length) out.push('## In short', '', list(doc.summary), '');
  for (const s of doc.sections ?? []) out.push(`## ${s.title}`, '', s.body.map(para).join('\n\n'), '');
  if (doc.outro) out.push(`_${doc.outro}_`, '');
  return out.join('\n');
}

export const pages = () => ({
  'docs/PRIVACY.md': page(legal.privacy, legal.updated),
  'docs/TERMS.md': page(legal.disclaimer, legal.updated),
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [file, text] of Object.entries(pages())) {
    const path = join(root, file);
    let now = '';
    try {
      now = readFileSync(path, 'utf8');
    } catch {
      // not made yet
    }
    if (now === text) continue;
    if (check) {
      console.error(`${file} is out of date: run node tools/legal-pages/make.mjs`);
      stale = true;
    } else writeFileSync(path, text);
  }
  if (stale) process.exit(1);
}

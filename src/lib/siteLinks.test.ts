import { describe, expect, it } from 'vitest';
import { webLink } from './site';

describe('webLink (0.10.1): only a web address is ever a link', () => {
  it('keeps http and https', () => {
    expect(webLink('https://www.coles.com.au/catalogues')).toBe('https://www.coles.com.au/catalogues');
    expect(webLink(' http://192.168.1.20:8787 ')).toBe('http://192.168.1.20:8787');
  });
  it('refuses scripts, data, files and addresses with a password', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'https://user:pass@example.com/', 'not a link', '', undefined, null])
      expect(webLink(bad as string)).toBeUndefined();
  });
});

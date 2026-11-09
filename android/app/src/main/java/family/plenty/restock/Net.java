package family.plenty.restock;

/** Small network helpers shared by the background code. */
final class Net {
    private Net() {}

    /**
     * A web address as a URL. Goes through URI (Java 20+ deprecates new URL(String)); an address
     * URI won't take, such as one with an unencoded space, falls back to the old way so nothing
     * that worked before stops working.
     */
    @SuppressWarnings("deprecation")
    static java.net.URL url(String s) throws java.net.MalformedURLException {
        try {
            return java.net.URI.create(s).toURL();
        } catch (IllegalArgumentException e) {
            return new java.net.URL(s);
        }
    }

    /**
     * 0.9.0: a web address read strictly, for deciding which site it's on, or null. A browser reads
     * some addresses differently from Java's old URL class (it takes "\" as "/", and quietly drops
     * tabs and line breaks anywhere and spaces at the ends), which could make an address look like
     * the shop's site to Restock while the browser goes somewhere else. So those, and any "user@"
     * part, are refused outright. Spaces inside it and a few other characters a browser would
     * encode itself (such as "|") are encoded first, and anything after "#" is left out (it never
     * changes the site).
     */
    static java.net.URI strictUri(String s) {
        if (s == null || s.isEmpty() || s.charAt(0) <= 0x20 || s.charAt(s.length() - 1) <= 0x20) return null;
        int hash = s.indexOf('#');
        if (hash >= 0) s = s.substring(0, hash);
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch < 0x20 || ch == 0x7f || ch == '\\') return null;
            if (" \"<>`{}|^".indexOf(ch) >= 0) b.append('%').append(Integer.toHexString(0x100 | ch).substring(1).toUpperCase(java.util.Locale.ROOT));
            else b.append(ch);
        }
        try {
            java.net.URI u = new java.net.URI(b.toString());
            return u.getRawUserInfo() != null ? null : u;
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }
}

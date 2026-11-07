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
}

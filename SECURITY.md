# Security

Restock keeps everything on your phone, but it still handles things worth protecting: loyalty and gift card numbers and PINs, receipts, backups, a Woolworths sign-in if you use one, the encrypted link between your household's phones if you use local sync, and, if you run one, your own Restock server with your household's data on it.

## Reporting a problem

**Please don't open a public issue for a security problem.** Instead, report it privately on GitHub:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Say what you found, how to make it happen, and what someone could do with it.

This covers the Restock server ([d-plenty/restock-server](https://github.com/d-plenty/restock-server)) too: report its problems here as well.

You'll get a reply as soon as possible, usually within a week. Once it's fixed, you'll be credited in the release notes if you'd like to be.

## What counts

- A way for another app, website or person to read Restock's data, backups, export files or receipt photos.
- Restock sending anything somewhere the privacy policy doesn't say it does.
- A shop's page, a backup file or an export file being able to run code or change the app.
- A way to read or change what local sync sends between phones, join a household without a one-time code, or keep syncing after being removed.
- On a Restock server: signing in without the passphrase, using a browser's session from another site, getting past the passphrase check on a delete or another admin action, or reading what the server keeps without signing in.
- Making the server contact anything other than the built-in shops' own addresses through **Let the web page search the shops**, or contact them without someone pressing Search.
- Problems in how official releases are signed or published, or how the server's image is built.

A shop's website blocking Restock or your server, or wrong prices, aren't security problems: please use the normal issue forms for those.

## Supported versions

Only the latest release of the app and of the server gets fixes while Restock is a release candidate.

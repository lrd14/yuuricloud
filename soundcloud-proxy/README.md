# SoundCloud and Last.fm proxy

A Cloudflare Worker that lets people use yuuricloud's SoundCloud app and Last.fm API account without their own
keys.

SoundCloud needs the app's **Client Secret** at two moments: when someone signs in, and when their login is
renewed (about once an hour). A secret built into the desktop app could be pulled out by anyone, so the app
sends just those two requests here instead. The Worker adds the secret and forwards them to SoundCloud.
Everything else (likes, playlists, search, streaming) goes straight from the app to SoundCloud with each
person's own login.

The Worker only accepts those two kinds of request. It only accepts the redirect URI in `wrangler.toml`, and
it never includes the secret in a reply. The worst someone can do by calling it directly is sign in to their
own SoundCloud account through your app.

**Last.fm** signs every call that acts for a user (signing in, "now playing" and scrobbles) with the API
account's **shared secret**. The app sends those calls to `/lastfm`, and the Worker adds the API key and the
signature and passes them to Last.fm. Only those four methods are signed; anything else is refused, and the
secret never appears in a reply. Calling it directly only lets someone sign in to their own Last.fm account, or
scrobble to an account whose session key they already have.

To turn it on:

1. Create an API account at https://www.last.fm/api/account/create (any name works).
2. Put its **API key** in `LASTFM_API_KEY` in `wrangler.toml` and in `BUILTIN_LASTFM_KEY` at the top of
   `src-tauri/src/integrations.rs`.
3. Run `npx wrangler secret put LASTFM_SECRET` and paste the **shared secret**.
4. Run `npx wrangler deploy` again, and rebuild the app.

## Deploy (free Cloudflare account)

From this folder:

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put SC_CLIENT_SECRET
```

- `login` opens the browser to sign in to Cloudflare.
- `deploy` prints the Worker's address, such as `https://yuuricloud-soundcloud.<you>.workers.dev`.
- `secret put` asks for the Client Secret and stores it encrypted in Cloudflare. It is never written to a file.

Then put that address in `BUILTIN_TOKEN_PROXY` at the top of `src-tauri/src/soundcloud.rs` and rebuild the
app.

`SC_CLIENT_ID` and `ALLOWED_REDIRECT` in `wrangler.toml` must match your SoundCloud app at
https://soundcloud.com/you/apps, and so must `BUILTIN_CLIENT_ID` in `soundcloud.rs`. If you reset the secret on
SoundCloud, run `secret put` again. Nothing in the app needs to change.

## Test

```bash
node test.mjs
```

This checks the request handling with SoundCloud mocked out.

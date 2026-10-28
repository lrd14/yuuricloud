# SoundCloud token proxy

A Cloudflare Worker that lets people use yuuricloud's SoundCloud app without their own keys.

SoundCloud needs the app's **Client Secret** at two moments: when someone signs in, and when their login is
renewed (about once an hour). A secret built into the desktop app could be pulled out by anyone, so the app
sends just those two requests here instead. The Worker adds the secret and forwards them to SoundCloud.
Everything else (likes, playlists, search, streaming) goes straight from the app to SoundCloud with each
person's own login.

The Worker only accepts those two kinds of request. It only accepts the redirect URI in `wrangler.toml`, and
it never includes the secret in a reply. The worst someone can do by calling it directly is sign in to their
own SoundCloud account through your app.

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

// Proxy for yuuricloud's shared SoundCloud app and Last.fm API account.
//
// SoundCloud wants the app's Client Secret when a user signs in and when their login is renewed.
// The secret can't safely ship inside the desktop app, so the app sends those two requests here
// and this Worker adds the secret before passing them on (/token). Everything else goes straight
// from the app to SoundCloud with each user's own login.
//
// The app's redirect URI is this Worker's /callback. SoundCloud sends the browser there after the
// user approves, and it goes on to where the sign-in started: the computer app listening on
// 127.0.0.1, or, for a sign-in a phone started (its state begins with "ios."), the phone app
// through a yuuricloud:// link.
//
// Last.fm signs every call that acts for a user (signing in, now playing, scrobbles) with the API
// account's shared secret, so those calls come here (/lastfm), get the key and signature added,
// and go on to Last.fm. Only those methods are let through.
//
// Settings (see README.md):
//   SC_CLIENT_ID      the app's Client ID (public)
//   SC_CLIENT_SECRET  the app's Client Secret — set with `wrangler secret put`, never in a file
//   ALLOWED_REDIRECT  the redirect URI registered for the app: this Worker's /callback
//   LASTFM_API_KEY    the Last.fm API key (public)
//   LASTFM_SECRET     the Last.fm shared secret — set with `wrangler secret put`, never in a file

const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
// where the computer app listens for the sign-in to come back
const DESKTOP_CALLBACK = "http://127.0.0.1:8974/callback";
// opens the phone app with the sign-in
const PHONE_CALLBACK = "yuuricloud://soundcloud-auth";
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
// What the app signs with the shared account: signing in, and scrobbling for a signed-in user
const LASTFM_METHODS = ["auth.getToken", "auth.getSession", "track.updateNowPlaying", "track.scrobble"];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/lastfm") return lastfm(request, env);
    if (url.pathname === "/callback") return callback(url);
    if (url.pathname !== "/token") return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!env.SC_CLIENT_ID || !env.SC_CLIENT_SECRET) {
      return json(500, { error: "server_error", error_description: "The proxy is missing its SoundCloud keys" });
    }

    let form;
    try {
      form = new URLSearchParams(await request.text());
    } catch {
      return json(400, { error: "invalid_request" });
    }

    const grant = form.get("grant_type");
    const out = new URLSearchParams({
      grant_type: grant,
      client_id: env.SC_CLIENT_ID,
      client_secret: env.SC_CLIENT_SECRET,
    });
    const needs = { authorization_code: ["code", "code_verifier", "redirect_uri"], refresh_token: ["refresh_token"] }[grant];
    if (!needs) return json(400, { error: "unsupported_grant_type" });
    for (const key of needs) {
      const value = form.get(key);
      if (!value || value.length > 2048) return json(400, { error: "invalid_request", error_description: `Missing ${key}` });
      out.set(key, value);
    }
    if (grant === "authorization_code" && env.ALLOWED_REDIRECT && out.get("redirect_uri") !== env.ALLOWED_REDIRECT) {
      return json(400, { error: "invalid_request", error_description: "Unexpected redirect_uri" });
    }

    const reply = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json; charset=utf-8" },
      body: out,
    });
    return new Response(await reply.text(), {
      status: reply.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  },
};

/** SoundCloud sending the browser back after approval: pass the answer on to the app that asked. */
function callback(url) {
  const answer = new URLSearchParams();
  for (const key of ["code", "state", "error", "error_description"]) {
    const value = url.searchParams.get(key);
    if (value !== null) answer.set(key, value.slice(0, 2048));
  }
  if (!(answer.get("state") || "").startsWith("ios.")) {
    return new Response(null, { status: 302, headers: { Location: `${DESKTOP_CALLBACK}?${answer}`, "Cache-Control": "no-store" } });
  }
  // Safari asks before opening an app, so the page offers a button too
  const target = `${PHONE_CALLBACK}?${answer}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const page = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>yuuricloud</title><meta http-equiv=refresh content="0;url=${target}">
<body style="font:17px system-ui;background:#15161b;color:#eee;display:grid;place-items:center;height:90vh;margin:0">
<div style="text-align:center;padding:24px"><h2>Back to yuuricloud</h2>
<p><a href="${target}" style="display:inline-block;padding:12px 22px;border-radius:10px;background:#8b7cff;color:#fff;text-decoration:none;font-weight:600">Open yuuricloud</a></p>
<p style="color:#aaa">If it doesn't open by itself, tap the button.</p></div>`;
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Sign a Last.fm call with the shared secret and pass it on. Replies come back unchanged. */
async function lastfm(request, env) {
  if (request.method !== "POST") return json(405, { error: 29, message: "Method not allowed" });
  if (!env.LASTFM_API_KEY || !env.LASTFM_SECRET) return json(500, { error: 16, message: "The proxy is missing its Last.fm keys" });
  let form;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return json(400, { error: 6, message: "Bad request" });
  }
  if (!LASTFM_METHODS.includes(form.get("method"))) return json(400, { error: 3, message: "Method not allowed through the proxy" });

  // the key and signature are ours to add; format isn't part of what's signed
  const params = new Map();
  for (const [key, value] of form) {
    if (["api_key", "api_sig", "format", "callback"].includes(key)) continue;
    if (key.length > 64 || value.length > 2048 || params.size >= 40) return json(400, { error: 6, message: "Bad request" });
    params.set(key, value);
  }
  params.set("api_key", env.LASTFM_API_KEY);
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const base = sorted.map(([k, v]) => k + v).join("") + env.LASTFM_SECRET;
  const out = new URLSearchParams(sorted);
  out.set("api_sig", md5(base));
  out.set("format", "json");

  const reply = await fetch(LASTFM_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "yuuricloud-proxy" },
    body: out,
  });
  return new Response(await reply.text(), {
    status: reply.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** MD5 of a string's UTF-8 bytes, as hex. Last.fm signatures use it and Web Crypto doesn't have it. */
function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const words = new Uint32Array((((bytes.length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[words.length - 2] = bytes.length * 8;
  words[words.length - 1] = Math.floor(bytes.length / 0x20000000);

  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f, g;
      if (round === 0) [f, g] = [(b & c) | (~b & d), i];
      else if (round === 1) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (round === 2) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const sum = (a + f + K[i] + words[chunk + g]) >>> 0;
      const shift = S[round * 4 + (i % 4)];
      [a, d, c] = [d, c, b];
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  return [a0, b0, c0, d0].map((n) => [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

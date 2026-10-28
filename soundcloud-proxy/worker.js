// Token proxy for yuuricloud's shared SoundCloud app.
//
// SoundCloud wants the app's Client Secret when a user signs in and when their login is renewed.
// The secret can't safely ship inside the desktop app, so the app sends those two requests here
// and this Worker adds the secret before passing them on. Nothing else goes through it: the app
// talks to SoundCloud directly with each user's own login.
//
// Settings (see README.md):
//   SC_CLIENT_ID      the app's Client ID (public)
//   SC_CLIENT_SECRET  the app's Client Secret — set with `wrangler secret put`, never in a file
//   ALLOWED_REDIRECT  the redirect URI registered for the app

const TOKEN_URL = "https://secure.soundcloud.com/oauth/token";

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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

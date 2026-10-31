// Checks the Worker's request handling with SoundCloud mocked out. Run: node soundcloud-proxy/test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "./worker.js";

const env = {
  SC_CLIENT_ID: "id123", SC_CLIENT_SECRET: "secret456", ALLOWED_REDIRECT: "http://127.0.0.1:8974/callback",
  LASTFM_API_KEY: "lfmkey", LASTFM_SECRET: "lfmsecret",
};
let sent = null;
globalThis.fetch = async (url, init) => {
  sent = { url, body: new URLSearchParams(init.body.toString()) };
  return new Response(JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }), { status: 200 });
};
const post = (body, path = "/token") =>
  worker.fetch(new Request("https://proxy.example" + path, { method: "POST", body: new URLSearchParams(body) }), env);

// sign-in: secret added, user fields passed through
let r = await post({ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: env.ALLOWED_REDIRECT });
assert.equal(r.status, 200);
assert.equal((await r.json()).access_token, "tok");
assert.equal(sent.url, "https://secure.soundcloud.com/oauth/token");
assert.equal(sent.body.get("client_secret"), "secret456");
assert.equal(sent.body.get("client_id"), "id123");
assert.equal(sent.body.get("code_verifier"), "v");

// refresh
sent = null;
r = await post({ grant_type: "refresh_token", refresh_token: "ref" });
assert.equal(r.status, 200);
assert.equal(sent.body.get("refresh_token"), "ref");

// a caller can't override the client or the secret
sent = null;
r = await post({ grant_type: "refresh_token", refresh_token: "ref", client_id: "evil", client_secret: "evil" });
assert.equal(sent.body.get("client_id"), "id123");
assert.equal(sent.body.get("client_secret"), "secret456");

// rejected without contacting SoundCloud
for (const [body, path, status] of [
  [{ grant_type: "client_credentials" }, "/token", 400],
  [{ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "https://evil.example/cb" }, "/token", 400],
  [{ grant_type: "refresh_token" }, "/token", 400],
  [{ grant_type: "refresh_token", refresh_token: "r" }, "/other", 404],
]) {
  sent = null;
  r = await post(body, path);
  assert.equal(r.status, status);
  assert.equal(sent, null);
}
r = await worker.fetch(new Request("https://proxy.example/token"), env);
assert.equal(r.status, 405);

// the secret never appears in a reply
r = await post({ grant_type: "client_credentials" });
assert.ok(!(await r.text()).includes("secret456"));

// Last.fm: key and signature added, as Last.fm documents (sorted name+value pairs, then the secret)
sent = null;
r = await post({ method: "track.scrobble", artist: "Björk", track: "Jóga", sk: "sess", timestamp: "123", api_key: "evil", api_sig: "evil", format: "xml" }, "/lastfm");
assert.equal(r.status, 200);
assert.equal(sent.url, "https://ws.audioscrobbler.com/2.0/");
assert.equal(sent.body.get("api_key"), "lfmkey");
assert.equal(sent.body.get("format"), "json");
const base = "api_keylfmkeyartistBjörkmethodtrack.scrobbleskSesstimestamp123trackJóga".replace("skSess", "sksess") + "lfmsecret";
assert.equal(sent.body.get("api_sig"), createHash("md5").update(base).digest("hex"));

// only the app's own methods get signed
for (const method of ["user.getInfo", "auth.getMobileSession", "", null]) {
  sent = null;
  r = await post(method === null ? { artist: "x" } : { method }, "/lastfm");
  assert.equal(r.status, 400);
  assert.equal(sent, null);
}
r = await post({ method: "track.scrobble" }, "/lastfm");
assert.ok(!(await r.text()).includes("lfmsecret"));

// SoundCloud coming back: on to the computer app, or the phone app for an "ios." sign-in
r = await worker.fetch(new Request("https://proxy.example/callback?code=c1&state=abc"), env);
assert.equal(r.status, 302);
assert.equal(r.headers.get("Location"), "http://127.0.0.1:8974/callback?code=c1&state=abc");
r = await worker.fetch(new Request("https://proxy.example/callback?error=access_denied&state=abc&evil=1"), env);
assert.equal(r.headers.get("Location"), "http://127.0.0.1:8974/callback?state=abc&error=access_denied");
r = await worker.fetch(new Request("https://proxy.example/callback?code=c2&state=ios.xyz"), env);
assert.equal(r.status, 200);
const page = await r.text();
assert.ok(page.includes('href="yuuricloud://soundcloud-auth?code=c2&amp;state=ios.xyz"'));
r = await worker.fetch(new Request('https://proxy.example/callback?code=%22%3E%3Cscript%3E&state=ios.x'), env);
assert.ok(!(await r.text()).includes("<script>"));

console.log("worker ok");

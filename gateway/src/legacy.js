// Beacon gateway: holds the GroupMe and Twilio secrets so cloud routines only
// need one key (GATEWAY_KEY). Secrets are set with `wrangler secret put`.
//
//   POST /call            {"message": "..."}        rings Jackson and reads the message
//   GET  /groupme/groups                            list groups (id, name, last message time)
//   GET  /groupme/messages?group_id=..&since_id=..  messages newer than since_id (max 100)
//
// Every request needs header  X-Jarvis-Key: <GATEWAY_KEY>.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function authorized(request, env) {
  const key = request.headers.get("X-Jarvis-Key") || "";
  if (!env.GATEWAY_KEY || key.length !== env.GATEWAY_KEY.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ env.GATEWAY_KEY.charCodeAt(i);
  return diff === 0;
}

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

async function placeCall(env, message) {
  const text = String(message || "").slice(0, 1500);
  if (!text.trim()) return json({ error: "message required" }, 400);
  // Trial accounts reject inline Twiml, so the message is served via twimlets echo.
  const twiml = `<Response><Pause length="1"/><Say>${escapeXml(text)}</Say></Response>`;
  const url = "https://twimlets.com/echo?Twiml=" + encodeURIComponent(twiml);
  const body = new URLSearchParams({ To: env.OWNER_NUMBER, From: env.TWILIO_NUMBER, Url: url });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`) },
    body,
  });
  const data = await res.json();
  return json({ sid: data.sid ?? null, status: data.status, error: data.message ?? null }, res.ok ? 200 : 502);
}

async function groupme(env, path, params) {
  const url = new URL("https://api.groupme.com/v3" + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-Access-Token": env.GROUPME_TOKEN } });
  if (res.status === 304) return json({ messages: [] }); // GroupMe: nothing newer than since_id
  const data = await res.json();
  return json(data.response ?? data, res.status);
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    const { pathname, searchParams } = new URL(request.url);

    if (request.method === "POST" && pathname === "/call") {
      const body = await request.json().catch(() => ({}));
      return placeCall(env, body.message);
    }
    if (request.method === "GET" && pathname === "/groupme/groups") {
      return groupme(env, "/groups", { per_page: "100", omit: "memberships" });
    }
    if (request.method === "GET" && pathname === "/groupme/messages") {
      const group = searchParams.get("group_id");
      if (!group) return json({ error: "group_id required" }, 400);
      return groupme(env, `/groups/${encodeURIComponent(group)}/messages`, {
        limit: "100",
        since_id: searchParams.get("since_id"),
      });
    }
    return json({ error: "not found" }, 404);
  },
};

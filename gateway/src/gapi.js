// The only code that calls Google (SAFETY rule 7, ROADMAP M3). Method + host + path allowlist: reads, Gmail
// drafts, labels and filters, calendar event create/update (cancel is an update), free/busy, and the OAuth token
// endpoint. Gmail send, delete, trash, modify and batch endpoints have no entry, so they are unreachable.
const ALLOW=[
  ['POST',/^https:\/\/oauth2\.googleapis\.com\/token$/],
  ['GET',/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events(\?|$)/],
  ['POST',/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events(\?|$)/],
  ['GET',/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/[A-Za-z0-9_-]{1,1024}(\?|$)/],
  ['PATCH',/^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/[A-Za-z0-9_-]{1,1024}(\?|$)/],
  ['POST',/^https:\/\/www\.googleapis\.com\/calendar\/v3\/freeBusy$/],
  ['GET',/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/(profile|labels|messages)(\?|$)/],
  ['GET',/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]{1,64}(\?|$)/],
  ['POST',/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/(drafts|labels|settings\/filters)$/],
  ['PUT',/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/drafts\/[A-Za-z0-9_-]{1,64}$/]
];
export const allowedGoogle=(method,url)=>ALLOW.some(([m,re])=>m===method&&re.test(String(url)));
// token: an access token (Bearer), or null for the token endpoint. body: object (JSON) or URLSearchParams.
export async function gfetch(method,url,token,body){
  url=String(url);if(!allowedGoogle(method,url))throw new Error('Google call not allowed');
  const json=body&&!(body instanceof URLSearchParams);
  return fetch(url,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(json?{'content-type':'application/json'}:{})},...(body?{body:json?JSON.stringify(body):body}:{}),signal:AbortSignal.timeout(15000)});
}

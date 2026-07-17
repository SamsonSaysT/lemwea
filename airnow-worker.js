/* =====================================================================
   LEMONS. — AirNow proxy worker
   ---------------------------------------------------------------------
   This tiny Cloudflare Worker holds your AirNow API key server-side so
   the public site can read real EPA ground-monitor AQI — the exact same
   numbers airnow.gov shows — without exposing the key.

   SETUP (~5 minutes, all free):
   1. Get a free AirNow API key: https://docs.airnowapi.org  → "Request an
      account" → key arrives by email.
   2. Cloudflare dashboard → Workers & Pages → Create → Worker.
      Name it something like  lemons-air . Paste this entire file in,
      replacing the hello-world code. Deploy.
   3. Worker → Settings → Variables and Secrets → Add:
         name:  AIRNOW_API_KEY     type: Secret     value: (your key)
      Save and redeploy.
   4. Copy the worker URL (https://lemons-air.<you>.workers.dev) into
      AIRNOW_PROXY at the top of app.js. Push the site. Done — the Air
      tab now says "AirNow ground monitors" and matches airnow.gov.

   Free-tier math: Workers allow 100k requests/day; AirNow allows 500/hr.
   Responses are cached at Cloudflare's edge for 10 minutes, so even a
   busy day stays comfortably inside both.
   ===================================================================== */

export default {
  async fetch(request, env, ctx){
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=600'
    };
    if(request.method === 'OPTIONS') return new Response(null, {headers: cors});

    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if(!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180){
      return new Response(JSON.stringify({error:'bad coords'}), {status:400, headers:{...cors, 'Content-Type':'application/json'}});
    }
    if(!env.AIRNOW_API_KEY){
      return new Response(JSON.stringify({error:'AIRNOW_API_KEY secret not set'}), {status:500, headers:{...cors, 'Content-Type':'application/json'}});
    }

    /* edge cache: one entry per rounded coordinate per 10 minutes */
    const cacheKey = new Request(`https://cache.lemons/air?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if(hit) return hit;

    const upstream = `https://www.airnowapi.org/aq/observation/latLong/current/`
      + `?format=application/json&latitude=${lat}&longitude=${lon}&distance=75&API_KEY=${env.AIRNOW_API_KEY}`;
    let body, status = 200;
    try{
      const r = await fetch(upstream, {cf:{cacheTtl:600}});
      body = await r.text();
      if(!r.ok) status = 502;
    }catch(e){
      body = JSON.stringify({error:'upstream failed'});
      status = 502;
    }
    const res = new Response(body, {status, headers:{...cors, 'Content-Type':'application/json'}});
    if(status === 200) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
};

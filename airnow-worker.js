/* =====================================================================
   LEMONS. — AirNow proxy worker  (v2.1)
   ---------------------------------------------------------------------
   v2.1 = v2 (distance ladder, no caching of empties) wrapped in a global
   try/catch so the worker can NEVER return a blank page or error screen —
   every failure comes back as readable JSON. The bare URL also reports
   its version, so you can always confirm what's actually deployed:
      https://<your-worker>/            ->  {"error":"bad coords","v":"2.1"}

   TO DEPLOY: Cloudflare -> Workers & Pages -> your worker -> Edit code ->
   select-all, delete, paste this ENTIRE file -> Deploy. Then visit the
   bare URL and confirm you see "v":"2.1".
   ===================================================================== */

export default {
  async fetch(request, env, ctx){
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json'
    };
    const json = (obj, status=200, extra={}) =>
      new Response(JSON.stringify(obj), {status, headers:{...cors, ...extra}});

    try{
      if(request.method === 'OPTIONS') return new Response(null, {headers: cors});

      const url = new URL(request.url);
      const lat = parseFloat(url.searchParams.get('lat'));
      const lon = parseFloat(url.searchParams.get('lon'));
      if(!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180){
        return json({error:'bad coords', v:'2.1'}, 400);
      }
      if(!env.AIRNOW_API_KEY){
        return json({error:'AIRNOW_API_KEY secret not set', v:'2.1'}, 500);
      }

      /* edge cache (v2 key space; only successful non-empty data is cached) */
      const cacheKey = new Request(`https://cache.lemons/air-v2?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
      const cache = caches.default;
      const hit = await cache.match(cacheKey);
      if(hit) return hit;

      /* distance ladder: shoreline & boundary points can miss at small radii */
      let data = null, lastErr = null;
      for(const distance of [75, 150]){
        const upstream = 'https://www.airnowapi.org/aq/observation/latLong/current/'
          + '?format=application/json&latitude=' + lat + '&longitude=' + lon
          + '&distance=' + distance + '&API_KEY=' + env.AIRNOW_API_KEY;
        try{
          const r = await fetch(upstream);
          if(!r.ok){ lastErr = 'upstream ' + r.status; continue; }
          const j = await r.json();
          if(Array.isArray(j) && j.length){ data = j; break; }
          lastErr = 'empty at ' + distance + 'mi';
        }catch(e){ lastErr = String(e && e.message || e); }
      }

      if(!data){
        /* nothing answered — respond empty, uncached, with the reason visible */
        return json([], 200, {'Cache-Control':'no-store', 'X-Lemons-Note': lastErr || 'no data'});
      }

      const res = new Response(JSON.stringify(data), {status:200, headers:{...cors, 'Cache-Control':'public, max-age=600'}});
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;

    }catch(err){
      /* absolute backstop: whatever breaks, say so in JSON */
      return json({error:'worker exception', detail:String(err && err.message || err), v:'2.1'}, 500);
    }
  }
};

/* =====================================================================
   LEMONS. — AirNow proxy worker  (v2)
   ---------------------------------------------------------------------
   v2 fixes shoreline/boundary gaps: AirNow's lat/long lookup can return
   an EMPTY result for points that sit between reporting areas (St. Clair
   Shores' geocoded center is basically in the lake). This version walks
   a distance ladder (75 -> 150 miles) until monitors answer, and never
   caches empty results, so a miss can't get locked in for 10 minutes.

   TO UPDATE: Cloudflare dashboard -> Workers & Pages -> your worker ->
   Edit code -> replace everything with this file -> Deploy. The
   AIRNOW_API_KEY secret you already set carries over automatically.
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

    /* edge cache (v2 key so old cached empties are abandoned) */
    const cacheKey = new Request(`https://cache.lemons/air-v2?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if(hit) return hit;

    /* distance ladder: shoreline & boundary points can miss at small radii */
    let data = null, lastErr = null;
    for(const distance of [75, 150]){
      const upstream = `https://www.airnowapi.org/aq/observation/latLong/current/`
        + `?format=application/json&latitude=${lat}&longitude=${lon}&distance=${distance}&API_KEY=${env.AIRNOW_API_KEY}`;
      try{
        const r = await fetch(upstream);
        if(!r.ok){ lastErr = 'upstream ' + r.status; continue; }
        const j = await r.json();
        if(Array.isArray(j) && j.length){ data = j; break; }
        lastErr = 'empty at ' + distance + 'mi';
      }catch(e){ lastErr = String(e && e.message || e); }
    }

    if(!data){
      /* no monitors answered — return empty WITHOUT caching, so the next
         request tries again immediately instead of inheriting a stale miss */
      return new Response('[]', {status:200, headers:{
        'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET, OPTIONS',
        'Cache-Control':'no-store', 'Content-Type':'application/json', 'X-Lemons-Note': lastErr || 'no data'
      }});
    }

    const res = new Response(JSON.stringify(data), {status:200, headers:{...cors, 'Content-Type':'application/json'}});
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
};

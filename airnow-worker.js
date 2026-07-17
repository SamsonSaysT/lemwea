/* =====================================================================
   LEMONS. — AirNow proxy worker  (v3.1)
   ---------------------------------------------------------------------
   v3.0 matches airnow.gov's number EXACTLY by doing what airnow.gov does:
   your coordinates are resolved to a ZIP code first (OpenStreetMap
   reverse-geocode, server-side), then AirNow is queried BY ZIP — which
   returns the reporting area their own ZIP table assigns you. v2 picked
   the nearest area centroid instead, which near a border (hi, Windsor)
   can grab a neighboring area's plume.

   Fallback chain: ZIP query -> lat/long at 75mi -> lat/long at 150mi.

   TO DEPLOY: Cloudflare -> Workers & Pages -> your worker -> Edit code ->
   select-all, delete, paste this ENTIRE file -> Deploy. Then confirm the
   bare URL shows {"error":"bad coords","v":"3.1"}.
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
        return json({error:'bad coords', v:'3.1'}, 400);
      }
      if(!env.AIRNOW_API_KEY){
        return json({error:'AIRNOW_API_KEY secret not set', v:'3.1'}, 500);
      }

      /* edge cache (v3 key space; only non-empty data is cached) */
      const cacheKey = new Request(`https://cache.lemons/air-v31?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`);
      const cache = caches.default;
      const hit = await cache.match(cacheKey);
      if(hit) return hit;

      const notes = [];

      /* step 1: coordinates -> ZIP (this is how airnow.gov assigns the area) */
      let zip = null;
      try{
        const g = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`,
          { headers: { 'User-Agent': 'lemonsweather.com air proxy (personal project)' } }
        );
        if(g.ok){
          const gj = await g.json();
          const pc = gj?.address?.postcode || '';
          const m = /^\d{5}/.exec(pc);          /* US 5-digit ZIPs only */
          if(m) zip = m[0];
          else notes.push('no US zip (' + (pc || 'none') + ')');
        }else notes.push('geocode ' + g.status);
      }catch(e){ notes.push('geocode fail'); }

      const attempts = [];
      if(zip) attempts.push(
        `https://www.airnowapi.org/aq/observation/zipCode/current/?format=application/json&zipCode=${zip}&distance=75&API_KEY=${env.AIRNOW_API_KEY}`
      );
      attempts.push(
        `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${lat}&longitude=${lon}&distance=75&API_KEY=${env.AIRNOW_API_KEY}`,
        `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=${lat}&longitude=${lon}&distance=150&API_KEY=${env.AIRNOW_API_KEY}`
      );

      let data = null;
      for(const upstream of attempts){
        try{
          const r = await fetch(upstream);
          if(!r.ok){ notes.push('upstream ' + r.status); continue; }
          const j = await r.json();
          if(Array.isArray(j) && j.length){ data = j; break; }
          notes.push('empty');
        }catch(e){ notes.push('fetch fail'); }
      }

      if(!data){
        return json([], 200, {'Cache-Control':'no-store', 'X-Lemons-Note': notes.join('; ') || 'no data'});
      }

      const res = new Response(JSON.stringify(data), {status:200, headers:{
        ...cors, 'Cache-Control':'public, max-age=300',
        'X-Lemons-Zip': zip || 'none'
      }});
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;

    }catch(err){
      return json({error:'worker exception', detail:String(err && err.message || err), v:'3.1'}, 500);
    }
  }
};

"use strict";
/* =====================================================================
   LEMONS. — a fresh-squeezed multi-source weather blend
   ===================================================================== */

/* ---------- tiny utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avg = arr => { const v = arr.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
const median = arr => {
  const v = arr.filter(x => typeof x === 'number' && isFinite(x)).sort((a,b)=>a-b);
  if(!v.length) return null;
  const m = Math.floor(v.length/2);
  return v.length%2 ? v[m] : (v[m-1]+v[m])/2;
};
/* Robust source squeeze: weather models occasionally throw a single absurd value.
   We use a median/MAD gate with a humane minimum band, then average only the core cluster. */
function robustSelect(items, valueFn, minBandC=2.8){
  const valid = items.filter(item=>{ const v=valueFn(item); return typeof v==='number' && isFinite(v); });
  if(valid.length < 4) return {kept:valid, omitted:[], median:median(valid.map(valueFn)), bandC:Infinity};
  const vals = valid.map(valueFn), med = median(vals);
  const mad = median(vals.map(v=>Math.abs(v-med))) || 0;
  const bandC = Math.max(minBandC, mad * 1.4826 * 2.8);
  let kept = valid.filter(item=>Math.abs(valueFn(item)-med) <= bandC);
  /* Never let a weirdly tight MAD throw away a large chunk of otherwise coherent models. */
  const floor = Math.max(3, Math.ceil(valid.length*0.67));
  if(kept.length < floor){
    kept = [...valid].sort((a,b)=>Math.abs(valueFn(a)-med)-Math.abs(valueFn(b)-med)).slice(0,floor);
  }
  const keepSet = new Set(kept);
  return {kept, omitted:valid.filter(x=>!keepSet.has(x)), median:med, bandC};
}
function robustAvg(values, minBand=0){
  const items=values.filter(v=>typeof v==='number'&&isFinite(v)).map(value=>({value}));
  if(!items.length) return null;
  const sel=robustSelect(items,x=>x.value,minBand);
  return avg(sel.kept.map(x=>x.value));
}
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
};
function fetchJSON(url, opts={}, timeout=12000){
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), timeout);
  return fetch(url, {...opts, signal: ctl.signal})
    .then(r => { if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .finally(()=>clearTimeout(t));
}
const cToF = c => c*9/5+32;
const kmhToMph = k => k*0.621371;

/* ---------- state ---------- */
const TABS = ['current','hourly','daily','radar','air'];
function parseSharedLocation(){
  const p = new URLSearchParams(location.search);
  const lat = parseFloat(p.get('lat'));
  const lon = parseFloat(p.get('lon'));
  if(!isFinite(lat) || !isFinite(lon)) return null;
  return {
    lat, lon,
    name: p.get('name') || 'Shared spot',
    admin: p.get('admin') || ''
  };
}
/* ---- REAL ground-station air quality (the accuracy fix) ----
   Every accurate AQI on the internet is EPA ground-monitor data via a keyed
   API. Deploy airnow-worker.js (in this repo) to a free Cloudflare Worker
   with a free AirNow key, paste the worker URL here, and the Air tab reads
   the exact same number as airnow.gov. Empty = model fallback. */
const AIRNOW_PROXY = 'https://lemons-air.hivemindtony.workers.dev';

const state = {
  // Plain visits always start at “Where are you, Lemons?”
  // Only a shared ?lat=&lon= link starts directly on a forecast.
  loc: parseSharedLocation(),             // {lat, lon, name, admin}
  unit: store.get('lemons.unit') || 'F',  // 'F' | 'C'
  hourlyHours: store.get('lemons.hourlyHours') || 72,
  savedPlaces: store.get('lemons.savedPlaces') || [],
  tz: undefined,
  sources: [],                            // normalized per-source data
  alerts: [],
  air: null,
  detail: null,                           // richer best-match metrics for click-through views
  extended: null,                         // ECMWF EC46 ensemble-mean guidance beyond normal forecast range
  historyCache: {},
  tab: 'current',
  radar: null
};

const DAILY_NORMAL_DAYS = 16;
const DAILY_EXTENDED_DAYS = 46;

/* ---------- weather-code helpers (WMO) ---------- */
function codeLabel(c){
  if(c==null) return '—';
  if(c===0) return 'Clear';
  if(c===1) return 'Mostly clear';
  if(c===2) return 'Partly cloudy';
  if(c===3) return 'Overcast';
  if(c===45||c===48) return 'Fog';
  if(c>=51&&c<=57) return 'Drizzle';
  if((c>=61&&c<=67)||c===80||c===81) return 'Rain';
  if(c===82) return 'Heavy rain';
  if((c>=71&&c<=77)||c===85||c===86) return 'Snow';
  if(c>=95) return 'Thunderstorm';
  return 'Mixed';
}
function iconFor(c, size=24, night=false){
  /* Filled, two-tone Lemons weather glyphs: more legible than the old hairline icons,
     but still flat and native to the cream / zest / leaf palette. */
  const S = `class="wxicon" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"`;
  const sun = `<g class="wxsun"><circle cx="18" cy="17" r="8"/><g fill="none" stroke="var(--rind)" stroke-width="2.4" stroke-linecap="round"><path d="M18 3v4M18 27v4M4 17h4M28 17h4M8.1 7.1l2.8 2.8M25.1 24.1l2.8 2.8M27.9 7.1l-2.8 2.8M10.9 24.1l-2.8 2.8"/></g></g>`;
  const moon = `<path class="wxmoon" d="M27.4 6.2A11 11 0 1 0 36 24.8 12.3 12.3 0 0 1 27.4 6.2Z"/>`;
  const cloud = `<path class="wxcloud" d="M13 35h22.5a7.5 7.5 0 0 0 1.2-14.9A10.2 10.2 0 0 0 17 18.3 7.5 7.5 0 0 0 13 35Z"/>`;
  const smallCloud = `<path class="wxcloud" d="M16 36h19a6.4 6.4 0 0 0 1-12.7 8.7 8.7 0 0 0-16.8-1.5A6.4 6.4 0 0 0 16 36Z"/>`;
  const drops = `<g class="wxrain" fill="none" stroke-width="3" stroke-linecap="round"><path d="M18 39l-2 5M27 39l-2 5M36 39l-2 5"/></g>`;
  const drizzle = `<g class="wxrain" fill="none" stroke-width="2.5" stroke-linecap="round"><path d="M19 40l-1 2M27 40l-1 2M35 40l-1 2"/></g>`;
  const snow = `<g class="wxsnow" fill="currentColor"><circle cx="18" cy="41" r="1.8"/><circle cx="27" cy="44" r="1.8"/><circle cx="36" cy="41" r="1.8"/></g>`;
  let body='';
  if(c===0||c===1) body = night ? moon : sun;
  else if(c===2) body = `${night?moon:sun}${smallCloud}`;
  else if(c===3) body = cloud;
  else if(c===45||c===48) body = `${smallCloud}<g class="wxfog" fill="none" stroke-width="2.2" stroke-linecap="round"><path d="M10 39h28M15 44h20"/></g>`;
  else if(c>=51&&c<=57) body = `${cloud}${drizzle}`;
  else if((c>=71&&c<=77)||c===85||c===86) body = `${cloud}${snow}`;
  else if(c>=95) body = `${cloud}<path class="wxbolt" d="M26 35h7l-5 6h5l-9 7 3-6h-5Z"/>`;
  else if(c>=61) body = `${cloud}${drops}`;
  else body = cloud;
  return `<svg ${S}>${body}</svg>`;
}
function codeSeverity(c){
  if(c==null) return 99;
  if(c===0) return 0;
  if(c===1) return 1;
  if(c===2) return 2;
  if(c===3) return 3;
  if(c===45||c===48) return 4;
  if(c>=51&&c<=57) return 5;
  if(c>=61&&c<=67) return 6;
  if(c>=71&&c<=77) return 6.5;
  if(c===80||c===81) return 7;
  if(c===82) return 7.5;
  if(c===85||c===86) return 7.5;
  if(c>=95) return 8;
  return 9;
}
function modeCode(codes){
  return pickWeatherCode(codes);
}
function pickWeatherCode(codes, precipAvg=null){
  const v = codes.filter(c=>c!=null && isFinite(c)).map(Number);
  if(!v.length) return null;
  const count = {};
  v.forEach(c=>count[c]=(count[c]||0)+1);
  const wetTie = typeof precipAvg === 'number' && isFinite(precipAvg) && precipAvg >= 45;
  return +Object.entries(count).sort((a,b)=>{
    const ca = a[1], cb = b[1];
    if(cb !== ca) return cb - ca;
    const sa = codeSeverity(+a[0]), sb = codeSeverity(+b[0]);
    // Old code picked the biggest WMO number on ties, so one thunder vote could beat one sunny vote.
    // Now ties choose the calmer icon unless the blended precip chance is genuinely high.
    return wetTie ? sb - sa : sa - sb;
  })[0][0];
}
const localPartFmtCache = new Map();
function localDateHour(epochH){
  const tz = state.tz || 'UTC';
  let fmt = localPartFmtCache.get(tz);
  if(!fmt){
    fmt = new Intl.DateTimeFormat('en-US', {timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'});
    localPartFmtCache.set(tz, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochH*3600000)).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`, hour:+parts.hour};
}
function representativeDailyCode(date, fallbackRows=[]){
  const dayCodes = [], dayPrecip = [];
  okSources().forEach(s=>{
    if(!s.hourly) return;
    for(const [h,row] of s.hourly.entries()){
      const lp = localDateHour(h);
      // Use late morning through afternoon for the daily icon. Daily weather_code can mean
      // “worst thing possible that day,” which made sunny days show as thunder.
      if(lp.date === date && lp.hour >= 10 && lp.hour <= 18){
        if(row.code!=null) dayCodes.push(row.code);
        if(row.precip!=null) dayPrecip.push(row.precip);
      }
    }
  });
  if(dayCodes.length) return pickWeatherCode(dayCodes, avg(dayPrecip));
  return pickWeatherCode(fallbackRows.map(r=>r.code), avg(fallbackRows.map(r=>r.precip)));
}

/* =====================================================================
   SOURCES — each returns:
   { id, name, ok, current:{tempC,feelsC,humidity,windKmh,code},
     hourly: Map(epochHour -> {tempC, precip, code}),
     daily:  Map('YYYY-MM-DD' -> {hiC, loC, precip, code}) }
   ===================================================================== */
const epochHour = iso => Math.floor(Date.parse(iso)/3600000);

/* ---- 1. Open-Meteo multi-model (7 independent models, one call) ---- */
const OM_MODELS = [
  {key:'ecmwf_ifs025',        name:'ECMWF'},
  {key:'gfs_seamless',        name:'NOAA GFS'},
  {key:'icon_seamless',       name:'DWD ICON'},
  {key:'ukmo_seamless',       name:'UK Met Office'},
  {key:'meteofrance_seamless',name:'Météo-France'},
  {key:'gem_seamless',        name:'Env. Canada GEM'},
  {key:'jma_seamless',        name:'JMA Japan'}
];
async function fetchOpenMeteo(lat, lon){
  const models = OM_MODELS.map(m=>m.key).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`
    + `&models=${models}&timezone=auto&forecast_days=16&wind_speed_unit=kmh`;
  let d;
  try{
    d = await fetchJSON(url);
  }catch(e){
    /* if the multi-model request is rejected for any reason, fall back to a
       single best_match call so the blend never loses Open-Meteo entirely */
    return [await fetchOpenMeteoSingle(lat, lon)];
  }
  state.tz = d.timezone || state.tz;
  const times = d.hourly.time.map(epochHour);
  const nowH = Math.floor(Date.now()/3600000);
  const nowIdx = Math.max(0, times.findIndex(t=>t>=nowH));

  return OM_MODELS.map(m=>{
    const g = suf => (d.hourly[`${suf}_${m.key}`] || d.hourly[suf] || []);
    const gd = suf => (d.daily[`${suf}_${m.key}`] || d.daily[suf] || []);
    const temps = g('temperature_2m');
    if(!temps.some(v=>v!=null)) return {id:m.key, name:m.name, ok:false};
    const hourly = new Map();
    times.forEach((t,i)=>{
      if(temps[i]==null) return;
      hourly.set(t, { tempC:temps[i], precip:(g('precipitation_probability')[i] ?? null), code:(g('weather_code')[i] ?? null) });
    });
    const daily = new Map();
    (d.daily.time||[]).forEach((date,i)=>{
      const hi = gd('temperature_2m_max')[i], lo = gd('temperature_2m_min')[i];
      if(hi==null&&lo==null) return;
      daily.set(date, {
        hiC:hi, loC:lo, precip:(gd('precipitation_probability_max')[i] ?? null), code:(gd('weather_code')[i] ?? null)
      });
    });
    const cur = {
      tempC: temps[nowIdx], feelsC: g('apparent_temperature')[nowIdx] ?? null,
      humidity: g('relative_humidity_2m')[nowIdx] ?? null,
      windKmh: g('wind_speed_10m')[nowIdx] ?? null,
      code: g('weather_code')[nowIdx] ?? null,
      precip: g('precipitation_probability')[nowIdx] ?? null
    };
    return {id:m.key, name:m.name, ok:true, current:cur, hourly, daily};
  });
}
/* single best_match fallback — used only if the multi-model call is rejected */
async function fetchOpenMeteoSingle(lat, lon){
  const base = {id:'om_best', name:'Open-Meteo blend'};
  try{
    const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code`
      + `&timezone=auto&forecast_days=16&wind_speed_unit=kmh`);
    state.tz = d.timezone || state.tz;
    const times = d.hourly.time.map(epochHour);
    const nowH = Math.floor(Date.now()/3600000);
    const nowIdx = Math.max(0, times.findIndex(t=>t>=nowH));
    const hourly = new Map();
    times.forEach((t,i)=>{
      if(d.hourly.temperature_2m[i]==null) return;
      hourly.set(t, { tempC:d.hourly.temperature_2m[i], precip:(d.hourly.precipitation_probability?.[i] ?? null), code:(d.hourly.weather_code?.[i] ?? null) });
    });
    const daily = new Map();
    (d.daily.time||[]).forEach((date,i)=>{
      daily.set(date, { hiC:d.daily.temperature_2m_max?.[i] ?? null, loC:d.daily.temperature_2m_min?.[i] ?? null,
        precip:d.daily.precipitation_probability_max?.[i] ?? null, code:d.daily.weather_code?.[i] ?? null });
    });
    const cur = { tempC:d.hourly.temperature_2m[nowIdx], feelsC:d.hourly.apparent_temperature?.[nowIdx] ?? null,
      humidity:d.hourly.relative_humidity_2m?.[nowIdx] ?? null, windKmh:d.hourly.wind_speed_10m?.[nowIdx] ?? null,
      code:d.hourly.weather_code?.[nowIdx] ?? null, precip:d.hourly.precipitation_probability?.[nowIdx] ?? null };
    return {...base, ok:true, current:cur, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}
/* dedicated lightweight sunrise/sunset fetch — no models param, nothing to fight with */
async function fetchSunTimes(lat, lon){
  try{
    const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=sunrise,sunset&timezone=auto&forecast_days=1`);
    state.tz = state.tz || d.timezone;
    state.sun = { sunrise: d.daily?.sunrise?.[0] ?? null, sunset: d.daily?.sunset?.[0] ?? null };
  }catch(e){ state.sun = null; }
}

/* One best-match feed supplies the richer secondary metrics used only after a row is opened.
   Headline temperatures/precip still come from the multi-source squeeze above. */
async function fetchForecastDetails(lat, lon){
  const hourlyFields = [
    'temperature_2m','apparent_temperature','relative_humidity_2m','dew_point_2m',
    'precipitation_probability','precipitation','rain','snowfall','weather_code','cloud_cover',
    'visibility','surface_pressure','wind_speed_10m','wind_direction_10m','wind_gusts_10m','is_day'
  ].join(',');
  const dailyFields = [
    'temperature_2m_max','temperature_2m_min','apparent_temperature_max','apparent_temperature_min',
    'precipitation_probability_max','precipitation_sum','rain_sum','snowfall_sum','precipitation_hours',
    'weather_code','uv_index_max','wind_speed_10m_max','wind_gusts_10m_max','wind_direction_10m_dominant',
    'sunrise','sunset','daylight_duration','sunshine_duration'
  ].join(',');
  const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=${hourlyFields}&daily=${dailyFields}&timezone=auto&forecast_days=16&wind_speed_unit=kmh`);
  state.tz = d.timezone || state.tz;
  const hourly = new Map();
  const hh = d.hourly || {};
  (hh.time||[]).forEach((iso,i)=> hourly.set(epochHour(iso), {
    tempC:hh.temperature_2m?.[i] ?? null,
    feelsC:hh.apparent_temperature?.[i] ?? null,
    humidity:hh.relative_humidity_2m?.[i] ?? null,
    dewC:hh.dew_point_2m?.[i] ?? null,
    precip:hh.precipitation_probability?.[i] ?? null,
    precipMm:hh.precipitation?.[i] ?? null,
    rainMm:hh.rain?.[i] ?? null,
    snowCm:hh.snowfall?.[i] ?? null,
    code:hh.weather_code?.[i] ?? null,
    cloud:hh.cloud_cover?.[i] ?? null,
    visibilityM:hh.visibility?.[i] ?? null,
    pressureHpa:hh.surface_pressure?.[i] ?? null,
    windKmh:hh.wind_speed_10m?.[i] ?? null,
    windDir:hh.wind_direction_10m?.[i] ?? null,
    gustKmh:hh.wind_gusts_10m?.[i] ?? null,
    isDay:hh.is_day?.[i] ?? null
  }));
  const daily = new Map();
  const dd = d.daily || {};
  (dd.time||[]).forEach((date,i)=> daily.set(date, {
    hiC:dd.temperature_2m_max?.[i] ?? null,
    loC:dd.temperature_2m_min?.[i] ?? null,
    feelsHiC:dd.apparent_temperature_max?.[i] ?? null,
    feelsLoC:dd.apparent_temperature_min?.[i] ?? null,
    precip:dd.precipitation_probability_max?.[i] ?? null,
    precipMm:dd.precipitation_sum?.[i] ?? null,
    rainMm:dd.rain_sum?.[i] ?? null,
    snowCm:dd.snowfall_sum?.[i] ?? null,
    precipHours:dd.precipitation_hours?.[i] ?? null,
    code:dd.weather_code?.[i] ?? null,
    uv:dd.uv_index_max?.[i] ?? null,
    windKmh:dd.wind_speed_10m_max?.[i] ?? null,
    gustKmh:dd.wind_gusts_10m_max?.[i] ?? null,
    windDir:dd.wind_direction_10m_dominant?.[i] ?? null,
    sunrise:dd.sunrise?.[i] ?? null,
    sunset:dd.sunset?.[i] ?? null,
    daylightSec:dd.daylight_duration?.[i] ?? null,
    sunshineSec:dd.sunshine_duration?.[i] ?? null
  }));
  return {ok:true, hourly, daily};
}


/* ---- sub-seasonal extension: ECMWF EC46 ensemble mean ----
   This is intentionally NOT blended into the first 16 days. It exists only to
   keep the calendar going after normal deterministic/model guidance ends.
   EC46 is coarse (~36 km), ensemble-based and best treated as a pattern signal. */
async function fetchExtendedOutlook(lat, lon){
  const dailyFields = ['temperature_2m_max','temperature_2m_min','precipitation_sum','cloud_cover_mean'].join(',');
  const weeklyFields = ['temperature_2m_anomaly','precipitation_anomaly'].join(',');
  const url = `https://seasonal-api.open-meteo.com/v1/seasonal?latitude=${lat}&longitude=${lon}`
    + `&daily=${dailyFields}&weekly=${weeklyFields}&models=ecmwf_ec46_ensemble_mean`
    + `&timezone=auto&forecast_days=${DAILY_EXTENDED_DAYS}`;
  const d = await fetchJSON(url, {}, 18000);
  const daily = new Map(), weekly=[];
  const dd=d.daily||{};
  (dd.time||[]).forEach((date,i)=> daily.set(date, {
    hiC:dd.temperature_2m_max?.[i] ?? null,
    loC:dd.temperature_2m_min?.[i] ?? null,
    precipMm:dd.precipitation_sum?.[i] ?? null,
    cloud:dd.cloud_cover_mean?.[i] ?? null,
    code:(()=>{
      const rain=dd.precipitation_sum?.[i] ?? 0, cloud=dd.cloud_cover_mean?.[i] ?? null;
      if(rain>=5) return 61;
      if(rain>=0.5) return 80;
      if(cloud==null) return 2;
      return cloud>=78?3:cloud>=38?2:cloud>=18?1:0;
    })()
  }));
  const ww=d.weekly||{};
  (ww.time||[]).forEach((date,i)=> weekly.push({
    date,
    tempAnomC:ww.temperature_2m_anomaly?.[i] ?? null,
    precipAnom:ww.precipitation_anomaly?.[i] ?? null
  }));
  return {ok:true, daily, weekly, model:'ECMWF EC46 ensemble mean', resolutionKm:36};
}

function extendedWeekForDate(date){
  const weeks=state.extended?.weekly||[];
  if(!weeks.length) return null;
  const t=new Date(date+'T12:00:00').getTime();
  let best=null;
  for(const w of weeks){
    const wt=new Date(w.date+'T12:00:00').getTime();
    if(wt<=t && t<wt+7*86400000) return w;
    if(wt<=t) best=w;
  }
  return best;
}
function extendedTempSignal(v){
  if(v==null || !isFinite(v)) return null;
  if(v>=1.5) return 'warmer than normal';
  if(v<=-1.5) return 'cooler than normal';
  return 'near normal';
}
function extendedPrecipSignal(v){
  if(v==null || !isFinite(v)) return null;
  if(v>=0.5) return 'wetter than normal';
  if(v<=-0.5) return 'drier than normal';
  return 'near normal';
}
function extendedConfidence(date){
  const today=new Date(new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date())+'T12:00:00');
  const d=Math.max(0,Math.round((new Date(date+'T12:00:00')-today)/86400000));
  return d<=23?'low':d<=34?'very low':'very low · pattern only';
}

/* ---- 2. NWS / weather.gov (US only) ---- */
function nwsCode(txt=''){
  const s = txt.toLowerCase();
  if(s.includes('thunder')) return 95;
  if(s.includes('snow')||s.includes('flurr')||s.includes('blizzard')) return 71;
  if(s.includes('sleet')||s.includes('ice')||s.includes('freezing')) return 67;
  if(s.includes('drizzle')) return 53;
  if(s.includes('rain')||s.includes('shower')) return 61;
  if(s.includes('fog')||s.includes('haze')||s.includes('smoke')) return 45;
  if(s.includes('mostly cloudy')||s.includes('overcast')) return 3;
  if(s.includes('partly')||s.includes('mostly sunny')||s.includes('mostly clear')) return 2;
  if(s.includes('sunny')||s.includes('clear')||s.includes('fair')) return 0;
  if(s.includes('cloud')) return 3;
  return null;
}
async function fetchNWS(lat, lon){
  const base = {id:'nws', name:'NWS · weather.gov'};
  try{
    const pt = await fetchJSON(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {}, 8000);
    const [hf, df] = await Promise.all([
      fetchJSON(pt.properties.forecastHourly, {}, 9000),
      fetchJSON(pt.properties.forecast, {}, 9000)
    ]);
    const hourly = new Map();
    (hf.properties.periods||[]).forEach(p=>{
      const tC = p.temperatureUnit==='F' ? (p.temperature-32)*5/9 : p.temperature;
      hourly.set(epochHour(p.startTime), { tempC:tC, precip:(p.probabilityOfPrecipitation?.value ?? null), code:nwsCode(p.shortForecast) });
    });
    const daily = new Map();
    (df.properties.periods||[]).forEach(p=>{
      const date = p.startTime.slice(0,10);
      const tC = p.temperatureUnit==='F' ? (p.temperature-32)*5/9 : p.temperature;
      const rec = daily.get(date) || {hiC:null, loC:null, precip:null, code:null};
      if(p.isDaytime){ rec.hiC = tC; rec.code = nwsCode(p.shortForecast); }
      else { rec.loC = tC; if(rec.code==null) rec.code = nwsCode(p.shortForecast); }
      const pp = p.probabilityOfPrecipitation?.value;
      if(pp!=null) rec.precip = Math.max(rec.precip ?? 0, pp);
      daily.set(date, rec);
    });
    const first = (hf.properties.periods||[])[0];
    const current = first ? {
      tempC: first.temperatureUnit==='F' ? (first.temperature-32)*5/9 : first.temperature,
      feelsC:null,
      humidity: first.relativeHumidity?.value ?? null,
      windKmh: (parseFloat(first.windSpeed)||0) * 1.60934 || null,
      code: nwsCode(first.shortForecast),
      precip: first.probabilityOfPrecipitation?.value ?? null
    } : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

async function fetchNWSAlerts(lat, lon){
  try{
    const d = await fetchJSON(`https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, {}, 9000);
    return (d.features || []).slice(0,4).map(f=>{
      const p = f.properties || {};
      return {
        event:p.event || 'Weather Alert',
        headline:p.headline || p.event || 'Weather Alert',
        severity:p.severity || '',
        urgency:p.urgency || '',
        expires:p.expires || p.ends || null,
        instruction:p.instruction || '',
        description:p.description || ''
      };
    });
  }catch(e){ return []; }
}

/* ---- 3. MET Norway ---- */
function metCode(sym=''){
  const s = sym.split('_')[0];
  const map = { clearsky:0, fair:1, partlycloudy:2, cloudy:3, fog:45,
    lightrain:61, rain:63, heavyrain:65, lightrainshowers:80, rainshowers:80, heavyrainshowers:82,
    lightsleet:67, sleet:67, heavysleet:67, lightsleetshowers:67, sleetshowers:67, heavysleetshowers:67,
    lightsnow:71, snow:73, heavysnow:75, lightsnowshowers:85, snowshowers:85, heavysnowshowers:86 };
  if(s.includes('thunder')) return 95;
  return map[s] ?? null;
}
async function fetchMetNo(lat, lon){
  const base = {id:'metno', name:'MET Norway'};
  try{
    const d = await fetchJSON(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    const ts = d.properties.timeseries || [];
    const hourly = new Map();
    const byDate = {};
    const fmt = new Intl.DateTimeFormat('en-CA', {timeZone: state.tz || undefined, year:'numeric', month:'2-digit', day:'2-digit'});
    ts.forEach(row=>{
      const det = row.data?.instant?.details; if(!det) return;
      const code = metCode(row.data?.next_1_hours?.summary?.symbol_code || row.data?.next_6_hours?.summary?.symbol_code || '');
      hourly.set(epochHour(row.time), { tempC:det.air_temperature, precip:null, code });
      const date = fmt.format(new Date(row.time));
      (byDate[date] = byDate[date] || {temps:[], codes:[]}).temps.push(det.air_temperature);
      if(code!=null) byDate[date].codes.push(code);
    });
    const daily = new Map();
    Object.entries(byDate).forEach(([date,v])=>{
      if(v.temps.length < 4) return; // partial day at the edges
      daily.set(date, { hiC:Math.max(...v.temps), loC:Math.min(...v.temps), precip:null, code:modeCode(v.codes) });
    });
    const cur = ts[0]?.data?.instant?.details;
    const current = cur ? { tempC:cur.air_temperature, feelsC:null, humidity:cur.relative_humidity ?? null,
      windKmh: cur.wind_speed!=null ? cur.wind_speed*3.6 : null, code: metCode(ts[0].data?.next_1_hours?.summary?.symbol_code||''), precip:null } : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

/* ---- 4. Bright Sky (DWD — Germany only) ---- */
function bsCode(cond=''){
  const map = {'clear-day':0,'clear-night':0,'partly-cloudy-day':2,'partly-cloudy-night':2,cloudy:3,fog:45,rain:61,sleet:67,snow:71,hail:77,thunderstorm:95,wind:3,dry:1};
  return map[cond] ?? null;
}
async function fetchBrightSky(lat, lon){
  const base = {id:'brightsky', name:'Bright Sky · DWD'};
  if(lat<47 || lat>55.2 || lon<5.5 || lon>15.5) return null; // outside Germany — skip quietly
  try{
    const today = new Date(), last = new Date(Date.now()+15*864e5);
    const iso = d => d.toISOString().slice(0,10);
    const d = await fetchJSON(`https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${iso(today)}&last_date=${iso(last)}`);
    const hourly = new Map(); const byDate = {};
    (d.weather||[]).forEach(w=>{
      if(w.temperature==null) return;
      const code = bsCode(w.icon || w.condition);
      hourly.set(epochHour(w.timestamp), { tempC:w.temperature, precip:(w.precipitation_probability ?? null), code });
      const date = w.timestamp.slice(0,10);
      (byDate[date] = byDate[date] || {temps:[], codes:[], pp:[]}).temps.push(w.temperature);
      if(code!=null) byDate[date].codes.push(code);
      if(w.precipitation_probability!=null) byDate[date].pp.push(w.precipitation_probability);
    });
    const daily = new Map();
    Object.entries(byDate).forEach(([date,v])=>{
      if(v.temps.length<4) return;
      daily.set(date, { hiC:Math.max(...v.temps), loC:Math.min(...v.temps), precip: v.pp.length?Math.max(...v.pp):null, code:modeCode(v.codes) });
    });
    const nowH = Math.floor(Date.now()/3600000);
    const c = hourly.get(nowH) || hourly.get(nowH+1);
    const current = c ? {tempC:c.tempC, feelsC:null, humidity:null, windKmh:null, code:c.code, precip:c.precip} : null;
    return {...base, ok:true, current, hourly, daily};
  }catch(e){ return {...base, ok:false}; }
}

/* ---- 5. Open-Meteo Air Quality + pollen ---- */
/* ---- US AQI, computed here the way AirNow does it ----
   Open-Meteo's us_aqi runs particulates through a 24-HOUR mean, so a smoke
   spike today gets diluted by yesterday's clean air (reads "Moderate" while
   the sky is orange). EPA's NowCast is a 12-hour ratio-weighted average that
   chases deteriorating air fast — that's what AirNow shows and what phones
   compare against. We compute NowCast for PM + current-hour gases, on the
   2024 breakpoints, and report the worst pollutant. */
const EPA_BP = {
  pm25: [[0,9.0,0,50],[9.1,35.4,51,100],[35.5,55.4,101,150],[55.5,125.4,151,200],[125.5,225.4,201,300],[225.5,325.4,301,500]],
  pm10: [[0,54,0,50],[55,154,51,100],[155,254,101,150],[255,354,151,200],[355,424,201,300],[425,604,301,500]],
  o3:   [[0,54,0,50],[55,70,51,100],[71,85,101,150],[86,105,151,200],[106,200,201,300]],
  no2:  [[0,53,0,50],[54,100,51,100],[101,360,101,150],[361,649,151,200]],
  so2:  [[0,35,0,50],[36,75,51,100],[76,185,101,150],[186,304,151,200]],
  co:   [[0,4.4,0,50],[4.5,9.4,51,100],[9.5,12.4,101,150],[12.5,15.4,151,200]]
};
function epaSubIndex(kind, conc){
  if(conc == null || !isFinite(conc) || conc < 0) return null;
  const table = EPA_BP[kind];
  for(const [bl, bh, il, ih] of table){
    if(conc <= bh) return Math.round((ih-il)/(bh-bl)*(Math.max(conc,bl)-bl)+il);
  }
  return 500;
}
/* EPA NowCast: vals[0] = most recent hour, up to 12 hours back */
function nowCast(vals){
  const c = vals.slice(0,12);
  const valid = c.filter(v=>v!=null && isFinite(v));
  if(!valid.length) return null;
  const recent = c.slice(0,3).filter(v=>v!=null && isFinite(v));
  if(recent.length < 2) return valid[0];
  const w = Math.max(Math.min(...valid)/Math.max(...valid) || 0, 0.5);
  let num = 0, den = 0;
  c.forEach((v,i)=>{ if(v!=null && isFinite(v)){ const wi = Math.pow(w,i); num += wi*v; den += wi; } });
  return den ? num/den : valid[0];
}
function usAqiAt(h, idx){
  const back = (name, n=12) => { const out=[]; for(let i=0;i<n;i++){ const v=h[name]?.[idx-i]; out.push(v==null?null:v); } return out; };
  const parts = {
    'PM2.5': epaSubIndex('pm25', nowCast(back('pm2_5'))),
    'PM10':  epaSubIndex('pm10', nowCast(back('pm10'))),
    'Ozone': epaSubIndex('o3',  (h.ozone?.[idx] ?? null) != null ? h.ozone[idx]/1.96 : null),
    'NO2':   epaSubIndex('no2', (h.nitrogen_dioxide?.[idx] ?? null) != null ? h.nitrogen_dioxide[idx]/1.88 : null),
    'SO2':   epaSubIndex('so2', (h.sulphur_dioxide?.[idx] ?? null) != null ? h.sulphur_dioxide[idx]/2.62 : null),
    'CO':    epaSubIndex('co',  (h.carbon_monoxide?.[idx] ?? null) != null ? h.carbon_monoxide[idx]/1145 : null)
  };
  let aqi = null, dominant = null;
  for(const [name, v] of Object.entries(parts)){
    if(v != null && (aqi == null || v > aqi)){ aqi = v; dominant = name; }
  }
  return {aqi, dominant, parts};
}
/* normalize an AirNow currentobservation payload -> {aqi, dominant}
   The API can return rows from SEVERAL reporting areas within the search
   radius. airnow.gov's headline is: your NEAREST area, worst pollutant
   within it. Taking the max across every area in 75 miles was reading
   some other town's plume as yours — so: group by area, pick the closest
   to the requested point, then take that area's worst pollutant. */
function normalizeAirnow(list, lat, lon){
  if(!Array.isArray(list) || !list.length) return null;
  const groups = new Map();
  for(const row of list){
    const v = row?.AQI;
    if(typeof v !== 'number' || v < 0) continue;
    const key = (row.Latitude != null && row.Longitude != null)
      ? row.Latitude + '|' + row.Longitude
      : (row.ReportingArea || 'x');
    if(!groups.has(key)) groups.set(key, {lat:row.Latitude, lon:row.Longitude, rows:[]});
    groups.get(key).rows.push(row);
  }
  if(!groups.size) return null;
  let best = null, bestD = Infinity;
  for(const g of groups.values()){
    const d = (isFinite(g.lat) && isFinite(g.lon) && isFinite(lat) && isFinite(lon))
      ? (g.lat-lat)*(g.lat-lat) + (g.lon-lon)*(g.lon-lon)
      : Infinity;
    if(d < bestD || best === null){ bestD = d; best = g; }
  }
  let aqi = null, dominant = null;
  const byName = new Map();
  for(const row of best.rows){
    const name = row.ParameterName === 'O3' ? 'Ozone' : (row.ParameterName || '?');
    if(!byName.has(name) || row.AQI > byName.get(name)) byName.set(name, row.AQI);
    if(aqi == null || row.AQI > aqi){ aqi = row.AQI; dominant = name; }
  }
  const pollutants = [...byName.entries()].map(([name, v])=>({name, aqi:v})).sort((x,y)=>y.aqi-x.aqi);
  let obsLabel = null;
  const r0 = best.rows[0];
  if(r0 && typeof r0.HourObserved === 'number'){
    const h = r0.HourObserved;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    obsLabel = h12 + (h < 12 ? ' AM' : ' PM') + (r0.LocalTimeZone ? ' ' + r0.LocalTimeZone : '');
  }
  return aqi == null ? null : {aqi, dominant, pollutants, obsLabel};
}
/* an active NWS air-quality / smoke alert means model numbers are suspect */
function smokeAlertActive(){
  return (state.alerts||[]).some(al=> /air quality|smoke|particulate/i.test(al.event||''));
}
async function fetchAirQuality(lat, lon){
  /* ground monitors are the primary source — fetched in parallel with the
     model so a slow or failed model call can never block real data */
  const groundP = AIRNOW_PROXY
    ? fetchJSON(`${AIRNOW_PROXY}/?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, {}, 9000)
        .then(obs=>normalizeAirnow(obs, lat, lon))
        .catch(e=>{ console.warn('AirNow proxy unreachable:', e && e.message); return null; })
    : Promise.resolve(null);
  const model = await fetchAirModel(lat, lon);
  const ground = await groundP;
  if(!model.ok && !ground) return {ok:false};
  const base = model.ok ? model : {ok:true, aqi:null, dominant:null, pm25:null, pm10:null, ozone:null, no2:null, co:null, pollen:[], hourly:[]};
  if(ground){ base.aqi = ground.aqi; base.dominant = ground.dominant; base.groundPollutants = ground.pollutants || []; base.obsLabel = ground.obsLabel || null; base.source = 'ground'; }
  else base.source = 'model';
  return base;
}
/* HRRR-Smoke inline map: NOAA publishes viewer graphics but not a stable
   documented image API, so we PROBE a small set of known path shapes across
   the last 8 hourly runs and show the first image that actually loads. If
   none do, the section keeps just the link to NOAA's viewer \u2014 no broken
   images, ever. Pure generator so the candidate list is testable. */
function hrrrSmokeCandidates(now = new Date()){
  const runs = [];
  for(let back = 1; back <= 8; back++){
    const d = new Date(now.getTime() - back*3600000);
    runs.push(d.getUTCFullYear()
      + String(d.getUTCMonth()+1).padStart(2,'0')
      + String(d.getUTCDate()).padStart(2,'0')
      + String(d.getUTCHours()).padStart(2,'0'));
  }
  const base = 'https://rapidrefresh.noaa.gov/hrrr/HRRRsmoke/for_web/hrrr_ncep_smoke_jet/';
  const shapes = [
    r => base + r + '/full/nsmoke_full_f00.png',
    r => base + r + '/full/nsmoke_f00_full.png',
    r => base + r + '/t1/nsmoke_t1_f00.png',
    r => base + r + '/full/trc1_sfc_full_f00.png'
  ];
  const out = [];
  for(const r of runs) for(const shape of shapes) out.push(shape(r));
  return out;
}
function initSmokeMap(){
  const img = $('#smokeimg');
  if(!img || img.dataset.probed) return;
  img.dataset.probed = '1';
  const candidates = hrrrSmokeCandidates();
  let i = 0;
  const tryNext = ()=>{
    if(i >= candidates.length) return; /* all missed: link-only section stays */
    const url = candidates[i++];
    const probe = new Image();
    probe.onload = ()=>{ img.src = url; img.classList.add('loaded'); };
    probe.onerror = tryNext;
    probe.src = url;
  };
  tryNext();
}
async function fetchAirModel(lat, lon){
  const fields = [
    'pm2_5','pm10','ozone','nitrogen_dioxide','sulphur_dioxide','carbon_monoxide',
    'alder_pollen','birch_pollen','grass_pollen','mugwort_pollen','olive_pollen','ragweed_pollen'
  ];
  try{
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`
      + `&hourly=${fields.join(',')}&timezone=auto&past_days=1&forecast_days=5`;
    const d = await fetchJSON(url, {}, 12000);
    const times = (d.hourly?.time || []).map(epochHour);
    const nowH = Math.floor(Date.now()/3600000);
    let idx = times.findIndex(t=>t>=nowH);
    if(idx < 0) idx = Math.max(0, times.length-1);
    const h = d.hourly || {};
    const get = name => h[name]?.[idx] ?? null;
    const pollen = [
      ['Grass', get('grass_pollen')], ['Ragweed', get('ragweed_pollen')],
      ['Birch', get('birch_pollen')], ['Alder', get('alder_pollen')],
      ['Mugwort', get('mugwort_pollen')], ['Olive', get('olive_pollen')]
    ].filter(x=>x[1]!=null).sort((a,b)=>b[1]-a[1]);
    let now = usAqiAt(h, idx);
    let source = 'model';
    const hourly = times.slice(idx, idx+24).map((t,i)=>{
      const j = idx+i;
      return { epochH:t, aqi:usAqiAt(h, j).aqi, pm25:h.pm2_5?.[j] ?? null, grass:h.grass_pollen?.[j] ?? null, ragweed:h.ragweed_pollen?.[j] ?? null };
    });
    return {
      ok:true,
      aqi:now.aqi, dominant:now.dominant, pm25:get('pm2_5'), pm10:get('pm10'), ozone:get('ozone'),
      no2:get('nitrogen_dioxide'), co:get('carbon_monoxide'), pollen, hourly
    };
  }catch(e){ return {ok:false}; }
}

/* =====================================================================
   BLEND — squeeze all sources into one consensus
   ===================================================================== */
async function loadWeather(){
  renderLoading();
  const {lat, lon} = state.loc;
  const [weatherResults, alertResult, airResult, detailResult, extendedResult] = await Promise.all([
    Promise.allSettled([fetchOpenMeteo(lat, lon), fetchNWS(lat, lon), fetchMetNo(lat, lon), fetchBrightSky(lat, lon)]),
    fetchNWSAlerts(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:[]})),
    fetchAirQuality(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:{ok:false}})),
    fetchForecastDetails(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:null})),
    fetchExtendedOutlook(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:null})),
    fetchSunTimes(lat, lon)
  ]);
  let sources = [];
  weatherResults.forEach(r=>{
    if(r.status!=='fulfilled' || r.value==null) return;
    Array.isArray(r.value) ? sources.push(...r.value) : sources.push(r.value);
  });
  state.sources = sources;
  state.alerts = alertResult.value || [];
  state.air = airResult.value || {ok:false};
  state.detail = detailResult.value || null;
  state.extended = extendedResult.value || null;
  state.updated = Date.now();
  if(!sources.some(s=>s.ok)){
    $('#app').innerHTML = `<div class="msg"><h2>The lemon came up dry.</h2>
      Couldn't reach any weather source — check the connection and <button class="linkish" onclick="loadWeather()">try again</button>.</div>`;
    return;
  }
  renderApp();
}
const okSources = () => state.sources.filter(s=>s.ok);

function consensusCurrent(){
  const pairs = okSources().filter(x=>x.current && x.current.tempC!=null).map(source=>({source,row:source.current}));
  const sel = robustSelect(pairs, x=>x.row.tempC, 2.8);
  const s = sel.kept;
  const temps = s.map(x=>x.row.tempC);
  return {
    tempC: avg(temps),
    feelsC: robustAvg(s.map(x=>x.row.feelsC), 2.8),
    humidity: robustAvg(s.map(x=>x.row.humidity), 18),
    windKmh: robustAvg(s.map(x=>x.row.windKmh), 18),
    code: pickWeatherCode(s.map(x=>x.row.code), robustAvg(s.map(x=>x.row.precip), 35)),
    precip: robustAvg(s.map(x=>x.row.precip), 35),
    spreadC: temps.length>1 ? Math.max(...temps)-Math.min(...temps) : 0,
    count: s.length,
    totalCount: pairs.length,
    omittedIds: sel.omitted.map(x=>x.source.id),
    includedIds: s.map(x=>x.source.id)
  };
}
function consensusHourly(hours=24){
  const start = Math.floor(Date.now()/3600000);
  const out = [];
  for(let h=start; h<start+hours; h++){
    const pairs = okSources().map(source=>({source,row:source.hourly?.get(h)})).filter(x=>x.row && x.row.tempC!=null);
    if(!pairs.length) continue;
    const sel = robustSelect(pairs, x=>x.row.tempC, 2.8);
    const rows = sel.kept.map(x=>x.row);
    const precip=robustAvg(rows.map(r=>r.precip), 35);
    out.push({ epochH:h, tempC:avg(rows.map(r=>r.tempC)), precip,
      code:pickWeatherCode(rows.map(r=>r.code), precip), count:rows.length,
      totalCount:pairs.length, omittedCount:sel.omitted.length });
  }
  return out;
}
function consensusDaily(days=DAILY_EXTENDED_DAYS){
  const dates = new Set();
  okSources().forEach(s=> s.daily && [...s.daily.keys()].forEach(d=>dates.add(d)));
  state.detail?.daily && [...state.detail.daily.keys()].forEach(d=>dates.add(d));
  state.extended?.daily && [...state.extended.daily.keys()].forEach(d=>dates.add(d));
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());

  // Normal forecast data gets absolute priority through its true horizon. The
  // seasonal feed is deliberately held back until AFTER that horizon so it can
  // never contaminate the regular Lemons squeeze.
  const normalDates=[];
  okSources().forEach(s=>s.daily && normalDates.push(...s.daily.keys()));
  state.detail?.daily && normalDates.push(...state.detail.daily.keys());
  const normalMax = normalDates.filter(d=>d>=todayStr).sort().at(-1) || null;

  return [...dates].filter(d=>d>=todayStr).sort().slice(0,days).map(date=>{
    const detail = state.detail?.daily?.get(date) || null;
    const ext = state.extended?.daily?.get(date) || null;
    const pairs = okSources().map(source=>({source,row:source.daily?.get(date)})).filter(x=>x.row && (x.row.hiC!=null || x.row.loC!=null));
    const insideNormal = normalMax && date<=normalMax;

    if(!pairs.length && (!detail || (detail.hiC==null && detail.loC==null))){
      if(!ext || (ext.hiC==null && ext.loC==null) || insideNormal) return null;
      const week=extendedWeekForDate(date);
      return {
        date,
        hiC:ext.hiC ?? null,
        loC:ext.loC ?? null,
        precip:null,
        precipMm:ext.precipMm ?? null,
        code:ext.code ?? null,
        count:51,
        totalCount:51,
        omittedCount:0,
        extended:true,
        fallback:false,
        tempAnomC:week?.tempAnomC ?? null,
        precipAnom:week?.precipAnom ?? null,
        tempSignal:extendedTempSignal(week?.tempAnomC),
        precipSignal:extendedPrecipSignal(week?.precipAnom),
        confidence:extendedConfidence(date)
      };
    }

    if(!pairs.length){
      if(!detail || (detail.hiC==null && detail.loC==null)) return null;
      return {
        date,
        hiC:detail.hiC ?? null,
        loC:detail.loC ?? null,
        precip:detail.precip ?? null,
        code:detail.code ?? null,
        count:1,
        totalCount:1,
        omittedCount:0,
        fallback:true,
        extended:false,
        sunrise:detail.sunrise ?? null,
        sunset:detail.sunset ?? null
      };
    }

    const hiSel=robustSelect(pairs.filter(x=>x.row.hiC!=null), x=>x.row.hiC, 3.3);
    const loSel=robustSelect(pairs.filter(x=>x.row.loC!=null), x=>x.row.loC, 3.3);
    const badIds=new Set([...hiSel.omitted,...loSel.omitted].map(x=>x.source.id));
    let keptPairs=pairs.filter(x=>!badIds.has(x.source.id));
    if(keptPairs.length<Math.max(3,Math.ceil(pairs.length*0.67))){
      keptPairs=robustSelect(pairs,x=>avg([x.row.hiC,x.row.loC]),3.3).kept;
    }
    const rows = keptPairs.map(x=>x.row);
    const precip=robustAvg(rows.map(r=>r.precip),35) ?? detail?.precip ?? null;
    return {
      date,
      hiC:avg(rows.map(r=>r.hiC)) ?? detail?.hiC ?? null,
      loC:avg(rows.map(r=>r.loC)) ?? detail?.loC ?? null,
      precip,
      code:representativeDailyCode(date, rows) ?? detail?.code ?? null,
      count:rows.length,
      totalCount:pairs.length,
      omittedCount:pairs.length-keptPairs.length,
      fallback:false,
      extended:false,
      sunrise:(rows.find(r=>r.sunrise)?.sunrise ?? detail?.sunrise ?? null),
      sunset:(rows.find(r=>r.sunset)?.sunset ?? detail?.sunset ?? null)
    };
  }).filter(d=>d && (d.hiC!=null||d.loC!=null));
}

/* =====================================================================
   RENDER
   ===================================================================== */
const T = c => c==null ? '—' : Math.round(state.unit==='F' ? cToF(c) : c);
const W = k => k==null ? '—' : Math.round(state.unit==='F' ? kmhToMph(k) : k);
const windUnit = () => state.unit==='F' ? 'mph' : 'km/h';
const degSpread = c => (state.unit==='F' ? c*9/5 : c);
const P = mm => mm==null ? '—' : state.unit==='F' ? `${(mm/25.4).toFixed(mm/25.4<0.1?2:1)} in` : `${mm.toFixed(mm<10?1:0)} mm`;
const SNOW = cm => cm==null ? '—' : state.unit==='F' ? `${(cm/2.54).toFixed(cm/2.54<1?1:0)} in` : `${cm.toFixed(cm<10?1:0)} cm`;
function windDir(deg){
  if(deg==null || !isFinite(deg)) return '';
  const dirs=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round((((deg%360)+360)%360)/22.5)%16];
}
function windText(kmh, dir){
  if(kmh==null) return '—';
  const d=windDir(dir); return `${d?d+' ':''}${W(kmh)} ${windUnit()}`;
}
function visText(m){
  if(m==null) return '—';
  return state.unit==='F' ? `${(m/1609.344).toFixed(m<16093?1:0)} mi` : `${(m/1000).toFixed(m<10000?1:0)} km`;
}
function durText(sec){
  if(sec==null || !isFinite(sec)) return '—';
  const h=Math.floor(sec/3600), m=Math.round((sec-h*3600)/60);
  return `${h} hr${h===1?'':'s'} ${m} min`;
}
function localDateForHour(epochH){ return localDateHour(epochH).date; }

function lemonSpinner(){
  return `<svg class="spin" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="42" fill="var(--zest)" stroke="var(--ink)" stroke-width="5"/>
    <circle cx="50" cy="50" r="29" fill="var(--pith)"/>
    <g stroke="var(--zest)" stroke-width="6" stroke-linecap="round">
      <path d="M50 27v46M27 50h46M34 34l32 32M66 34L34 66"/></g></svg>`;
}
function renderLoading(){
  $('#app').innerHTML = `<div class="msg">${lemonSpinner()}<h2>Squeezing the sources…</h2>ECMWF · GFS · ICON · UKMO · Météo-France · NWS alerts · air + pollen</div>`;
}


function setTopActions(html){
  const el = $('#topActions');
  if(!el) return;
  el.innerHTML = html || '';
  el.classList.toggle('hidden', !html);
}

function renderLocationScreen(){
  setTopActions('');
  const insecure = !window.isSecureContext;
  $('#app').innerHTML = `
    <div class="locscreen">
      <h1>Where are you, Lemons?</h1>
      <p>Pick a spot and I'll blend every free forecast model I can reach into one juicy consensus.</p>
      <button class="btn" id="geobtn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>
        Use my location</button>
      <div id="locerror" class="locerror" role="status">${insecure ? 'Location is blocked because this file is open locally/content://. Publish it to GitHub Pages HTTPS or run it on localhost.' : ''}</div>
      <span class="or">or search</span>
      <div class="searchbox">
        <input id="citysearch" type="search" placeholder="City, town, or ZIP…" autocomplete="off" aria-label="Search for a city, town, or ZIP code">
        <ul class="results" id="cityresults"></ul>
      </div>
      <div id="savedstrip"></div>
      <p class="lochelp">Search checks Open-Meteo/GeoNames first, then OpenStreetMap for smaller US towns and ZIPs. Try things like <b>Detroit MI</b>, <b>Lakewood OH</b>, or <b>48220</b>.</p>
    </div>`;
  $('#geobtn').addEventListener('click', geolocate);
  renderSavedStrip();
  const input = $('#citysearch');
  let deb;
  input.addEventListener('input', ()=>{ clearTimeout(deb); deb = setTimeout(()=>searchCity(input.value.trim()), 700); });
}
function renderSavedStrip(){
  const el = $('#savedstrip'); if(!el) return;
  if(!state.savedPlaces.length){ el.innerHTML = ''; return; }
  el.innerHTML = `<div class="savedstrip">${state.savedPlaces.map((p,i)=>`
    <span class="savedplace"><button data-place="${i}">${esc(p.name)}</button><button class="saveditsx" data-remove="${i}" aria-label="Remove ${esc(p.name)}">×</button></span>`).join('')}</div>`;
  el.querySelectorAll('[data-place]').forEach(b=>b.addEventListener('click', ()=>setLocation(state.savedPlaces[+b.dataset.place])));
  el.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click', e=>{ e.stopPropagation(); removeSavedPlace(+b.dataset.remove); }));
}
function setLocError(msg){ const el = $('#locerror'); if(el) el.textContent = msg || ''; }
async function geolocate(){
  const btn = $('#geobtn');
  if(!navigator.geolocation){ setLocError('This browser does not support location. Use search instead.'); return; }
  if(!window.isSecureContext){
    setLocError('Chrome blocks location on local/content:// files. Upload to GitHub Pages and open the https:// URL, or run a local localhost server.');
    if(btn) btn.textContent = 'Location needs HTTPS';
    return;
  }
  try{
    if(navigator.permissions){
      const p = await navigator.permissions.query({name:'geolocation'});
      if(p.state === 'denied'){
        setLocError('Location is denied for this browser/site. Tap the lock icon or site settings and allow Location, or use search.');
        if(btn) btn.textContent = 'Location denied — use search';
        return;
      }
    }
  }catch(e){}
  if(btn) btn.textContent = 'Locating…';
  setLocError('');
  navigator.geolocation.getCurrentPosition(async pos=>{
    const {latitude:lat, longitude:lon} = pos.coords;
    let name = 'My location', admin = '';
    /* Nominatim (OpenStreetMap) first — it resolves incorporated US suburbs
       like St. Clair Shores or Grosse Pointe, where metro-anchored geocoders
       just say "Detroit". zoom=12 targets the town, not the whole metro. */
    try{
      const n = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&addressdetails=1&accept-language=en`);
      const a = n.address || {};
      name = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.neighbourhood || a.county || n.name || name;
      admin = a.state || a.country || '';
    }catch(e){
      try{
        const g = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
        /* prefer the fine-grained locality over .city, which snaps to the metro */
        name = g.locality || g.localityInfo?.administrative?.slice(-1)[0]?.name || g.city || name;
        admin = g.principalSubdivision || g.countryName || '';
      }catch(_e){}
    }
    setLocation({lat, lon, name, admin});
  }, err=>{
    const insecure = !window.isSecureContext;
    const msg = insecure ? 'Location is blocked on local/content:// files. Use the GitHub Pages https:// link.'
      : err.code === 1 ? 'Location blocked. Allow Location in browser/site settings, or use search.'
      : err.code === 2 ? 'Your device could not find a position. Try Wi‑Fi/GPS or use search.'
      : 'Location timed out. Try again or use search.';
    setLocError(msg);
    if(btn) btn.textContent = 'Use my location';
  }, {enableHighAccuracy:true, timeout:15000, maximumAge:300000});
}
function normalizePlace(r, source){
  if(source === 'nominatim'){
    const a = r.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || r.name || (r.display_name||'').split(',')[0];
    const admin = [a.state, a.country_code ? a.country_code.toUpperCase() : ''].filter(Boolean).join(', ');
    return {lat:+r.lat, lon:+r.lon, name, admin, source:'OpenStreetMap'};
  }
  return {lat:r.latitude, lon:r.longitude, name:r.name, admin:[r.admin1, r.admin2, r.country_code].filter(Boolean).join(', '), source:'Open-Meteo'};
}
function dedupePlaces(list){
  const seen = new Set(), out = [];
  for(const p of list){
    if(!p || !isFinite(p.lat) || !isFinite(p.lon) || !p.name) continue;
    const key = `${p.name.toLowerCase()}|${(p.admin||'').toLowerCase()}|${p.lat.toFixed(2)}|${p.lon.toFixed(2)}`;
    if(seen.has(key)) continue;
    seen.add(key); out.push(p);
  }
  return out.slice(0,40);
}
async function searchCity(q){
  const ul = $('#cityresults'); if(!ul) return;
  if(q.length<2){ ul.innerHTML=''; return; }
  ul.innerHTML = `<li><button disabled>Searching the map…</button></li>`;
  const enc = encodeURIComponent(q);
  const jobs = [
    fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=100&language=en&format=json`).then(d => (d.results||[]).map(r=>normalizePlace(r,'openmeteo'))),
    fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=100&language=en&format=json&countryCode=US`).then(d => (d.results||[]).map(r=>normalizePlace(r,'openmeteo')))
  ];
  if(q.length >= 3){
    jobs.push(fetchJSON(`https://nominatim.openstreetmap.org/search?q=${enc}&format=jsonv2&addressdetails=1&limit=25&countrycodes=us&accept-language=en`, {}, 10000).then(d => (d||[]).map(r=>normalizePlace(r,'nominatim'))));
  }
  try{
    const settled = await Promise.allSettled(jobs);
    const places = dedupePlaces(settled.flatMap(x => x.status === 'fulfilled' ? x.value : []));
    window.__lemonsPlaces = places;
    ul.innerHTML = places.map((r,i)=>
      `<li><button data-i="${i}">${esc(r.name)} <span class="cc">${esc(r.admin)} · ${esc(r.source)}</span></button></li>`).join('')
      || `<li><button disabled>No luck — try town + state or a ZIP code</button></li>`;
    ul.querySelectorAll('button[data-i]').forEach(b=>b.addEventListener('click', ()=>{
      const r = window.__lemonsPlaces[+b.dataset.i];
      setLocation({lat:r.lat, lon:r.lon, name:r.name, admin:r.admin});
    }));
  }catch(e){ ul.innerHTML = `<li><button disabled>Search failed — try again</button></li>`; }
}
function setLocation(loc){
  state.loc = loc;
  if(state.radar){ state.radar.destroy(); state.radar = null; }
  loadWeather();
}

function placeKey(p){ return `${String(p.name||'').toLowerCase()}|${(+p.lat).toFixed(3)}|${(+p.lon).toFixed(3)}`; }
function isSavedPlace(p){ return state.savedPlaces.some(x=>placeKey(x) === placeKey(p)); }
function saveCurrentPlace(){
  if(!state.loc) return;
  if(isSavedPlace(state.loc)){ flash('already tucked in the lemon list'); return; }
  state.savedPlaces = [state.loc, ...state.savedPlaces].slice(0,12);
  store.set('lemons.savedPlaces', state.savedPlaces);
  flash('saved to the little lemon list');
  renderSavedStrip();
}
function removeSavedPlace(i){
  state.savedPlaces.splice(i,1);
  store.set('lemons.savedPlaces', state.savedPlaces);
  renderSavedStrip();
}
function shareCurrentLocation(){
  if(!state.loc) return;
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('lat', (+state.loc.lat).toFixed(5));
  u.searchParams.set('lon', (+state.loc.lon).toFixed(5));
  u.searchParams.set('name', state.loc.name || 'Lemons spot');
  if(state.loc.admin) u.searchParams.set('admin', state.loc.admin);
  const link = u.toString();
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(link).then(()=>flash('share link copied, smooth')).catch(()=>window.prompt('Copy this link', link));
  }else{
    window.prompt('Copy this link', link);
  }
}
function flash(msg){
  let t = $('#toast');
  if(!t){ t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(window.__lemonsToast);
  window.__lemonsToast = setTimeout(()=>t.classList.remove('show'), 1800);
}
/* ---------- sky strip: sunrise / sunset / moon, up by the location ---------- */
function skyTime(iso){
  if(!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  return new Intl.DateTimeFormat('en-US', {hour:'numeric', minute:'2-digit', timeZone:state.tz||undefined})
    .format(d).replace(' AM','a').replace(' PM','p');
}
/* pure-math backup so the strip never goes missing (±2 min) */
function solarTimes(lat, lon, offsetDays=0){
  const rad = Math.PI/180, now = new Date(Date.now() + offsetDays*86400000);
  const doy = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(),0,0)) / 86400000);
  const decl = -23.44 * Math.cos(rad*(360/365)*(doy+10));
  const cosHA = Math.cos(rad*90.833)/(Math.cos(rad*lat)*Math.cos(rad*decl)) - Math.tan(rad*lat)*Math.tan(rad*decl);
  if(cosHA < -1 || cosHA > 1) return null; // polar day/night
  const ha = Math.acos(cosHA)/rad;
  const B = rad*(360/365)*(doy-81);
  const eot = 9.87*Math.sin(2*B) - 7.53*Math.cos(B) - 1.5*Math.sin(B);
  const noonMin = 720 - 4*lon - eot;
  const dayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { sunrise: new Date(dayUTC + (noonMin - 4*ha)*60000), sunset: new Date(dayUTC + (noonMin + 4*ha)*60000) };
}
function moonPhase(){
  const synodic = 29.530588853;
  const days = Date.now()/86400000 - Date.UTC(2000,0,6,18,14)/86400000;
  const age = ((days % synodic) + synodic) % synodic;
  const frac = (1 - Math.cos(2*Math.PI*age/synodic)) / 2;
  const waxing = age < synodic/2;
  const name = frac<0.06 ? 'New moon' : frac<0.35 ? (waxing?'Waxing crescent':'Waning crescent')
    : frac<0.65 ? (waxing?'First quarter':'Last quarter')
    : frac<0.94 ? (waxing?'Waxing gibbous':'Waning gibbous') : 'Full moon';
  const toFull = waxing ? (synodic/2 - age) : (synodic - age + synodic/2);
  const toNew = synodic - age;
  return { frac, waxing, name, age, synodic,
    nextFull: new Date(Date.now() + toFull*86400000),
    nextNew:  new Date(Date.now() + toNew*86400000) };
}
/* Shadow region for the un-lit part of the disc (waxing orientation: shadow on the left).
   The terminator is a half-ellipse whose x-radius follows the phase — this is the
   geometrically accurate shape, not a canned glyph. Mirror the group for waning. */
function moonShadowPath(cx, cy, r, frac){
  if(frac >= 0.99) return '';
  if(frac <= 0.01) return `M ${cx-r} ${cy} a ${r} ${r} 0 1 0 ${r*2} 0 a ${r} ${r} 0 1 0 ${-r*2} 0 Z`;
  const rx = (Math.abs(Math.cos(Math.PI*frac)) * r).toFixed(2);
  const innerSweep = frac < 0.5 ? 0 : 1;
  return `M ${cx} ${cy-r} A ${r} ${r} 0 0 0 ${cx} ${cy+r} A ${rx} ${r} 0 0 ${innerSweep} ${cx} ${cy-r} Z`;
}
function moonIcon(frac, waxing){
  const shadow = moonShadowPath(12, 12, 8, frac);
  const flip = waxing ? '' : ' transform="scale(-1 1) translate(-24 0)"';
  return `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
    <circle cx="12" cy="12" r="8" fill="var(--zest)"/>
    ${shadow?`<g${flip}><path d="${shadow}" fill="rgba(35,36,27,.8)"/></g>`:''}
    <circle cx="12" cy="12" r="8" fill="none" stroke="var(--ink)" stroke-width="1.5"/></svg>`;
}
function sunHalfIcon(rise){
  /* top half of the lemon slice over the horizon for rise, bottom half under it for set */
  const half = rise
    ? `<path d="M4.5 14a7.5 7.5 0 0 1 15 0Z" fill="var(--zest)" stroke="var(--ink)" stroke-width="1.5" stroke-linejoin="round"/>
       <path d="M12 8v5.2M8.6 9.4l3.4 3.8M15.4 9.4L12 13.2" stroke="var(--pith)" stroke-width="1.2" stroke-linecap="round"/>`
    : `<path d="M19.5 14a7.5 7.5 0 0 1-15 0Z" fill="var(--zest)" stroke="var(--ink)" stroke-width="1.5" stroke-linejoin="round"/>
       <path d="M12 20v-5.2M8.6 18.6l3.4-3.8M15.4 18.6L12 14.8" stroke="var(--pith)" stroke-width="1.2" stroke-linecap="round"/>`;
  return `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">${half}
    <path d="M2.5 14h19" stroke="var(--ink)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
function renderSkyStrip(today){
  let sunrise = state.sun?.sunrise || today?.sunrise, sunset = state.sun?.sunset || today?.sunset;
  if((!sunrise || !sunset) && state.loc){
    const calc = solarTimes(state.loc.lat, state.loc.lon);
    if(calc){ sunrise = sunrise || calc.sunrise; sunset = sunset || calc.sunset; }
  }
  const moon = moonPhase();
  const bits = [];
  if(sunrise) bits.push(`<span class="sunpeek" title="Sunrise">${sunHalfIcon(true)}${skyTime(sunrise)}</span>`);
  if(sunset)  bits.push(`<span class="sunpeek" title="Sunset">${sunHalfIcon(false)}${skyTime(sunset)}</span>`);
  bits.push(`<span id="moonpeek" title="${esc(moon.name)}">${moonIcon(moon.frac, moon.waxing)}${Math.round(moon.frac*100)}%</span>`);
  return `<div class="skystrip">${bits.join('')}</div>`;
}

function formatTime(iso){
  if(!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {hour:'numeric', minute:'2-digit', timeZone:state.tz||undefined}).format(new Date(iso));
}
function lemonFruit(size=22, label=''){
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" role="img" aria-label="${esc(label)}">
    <path d="M2.4 12 C2.4 10.9 3.2 9.9 4.3 9.6 C5.7 6.8 8.6 5 12 5 C15.4 5 18.3 6.8 19.7 9.6 C20.8 9.9 21.6 10.9 21.6 12 C21.6 13.1 20.8 14.1 19.7 14.4 C18.3 17.2 15.4 19 12 19 C8.6 19 5.7 17.2 4.3 14.4 C3.2 14.1 2.4 13.1 2.4 12 Z"
      fill="var(--zest)" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M13.6 5.4 C13.2 3.3 14.9 1.9 17.1 2.1 C17.2 4.1 15.7 5.5 13.6 5.4 Z"
      fill="var(--leaf)" stroke="var(--ink)" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M5.6 10.6 C6.6 8.9 8.1 7.8 9.9 7.3" fill="none" stroke="var(--pith)" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;
}
function alertUntil(a){ return a.expires ? `until ${formatTime(a.expires)}` : ''; }
function renderAlerts(){
  if(!state.alerts || !state.alerts.length) return '';
  return `<div class="alertstack">${state.alerts.map(a=>`
    <div class="lemonalert">
      <div class="alerthead">${lemonFruit(18)}<span class="alertkind">${esc(a.event)}</span>${alertUntil(a)?`<span class="alertwhen">${esc(alertUntil(a))}</span>`:''}</div>
      ${a.headline?`<p class="alertline">${esc(a.headline)}</p>`:''}
    </div>`).join('')}</div>`;
}
function firstRainWindow(hours){
  return hours.find(h => h.precip != null && h.precip >= 35);
}
/* Deterministic daily pick — same line all day, new line tomorrow. */
function pickLine(arr, slot=0){
  const seed = new Date().toISOString().slice(0,10) + (state.loc?.name||'') + slot;
  let h = 0;
  for(const ch of seed) h = (h*31 + ch.charCodeAt(0)) >>> 0;
  return arr[h % arr.length];
}
function lemonsSays(cur, today){
  const hours = consensusHourly(18);
  const rain = firstRainWindow(hours);
  const aqi = state.air?.ok && state.air.aqi!=null ? state.air.aqi : null;
  const feels = cur.feelsC ?? cur.tempC;
  const lines = [];

  if(state.alerts?.length){
    const alertText = (state.alerts[0].event || '').toLowerCase();
    if(alertText.includes('heat')) lines.push(pickLine([
      'Actual heat advisory today — this one isn\u2019t a joke. Water, shade, repeat.',
      'Heat alert is live. The sun is not your friend today, it\u2019s your landlord.'
    ], 1));
    else if(alertText.includes('winter') || alertText.includes('snow') || alertText.includes('ice') || alertText.includes('blizzard')) lines.push(pickLine([
      'Winter alert\u2019s up. Give the car ten minutes and every other driver a hundred feet.',
      'Ice-adjacent alert today. Walk like a penguin, park like a coward.'
    ], 1));
    else if(alertText.includes('storm') || alertText.includes('thunder') || alertText.includes('tornado')) lines.push(pickLine([
      'Real storm warning up. Charge the phone, keep the plans loose.',
      'The weather service is officially worried, which means you should be at least mildly.'
    ], 1));
    else if(alertText.includes('flood')) lines.push(pickLine([
      'Flood alert\u2019s live. Do not test puddles of unknown depth.',
      'Flood warning today. That\u2019s not a shortcut, that\u2019s a lake now.'
    ], 1));
    else if(alertText.includes('air quality') || alertText.includes('smoke')) lines.push(
      'Air quality alert is active. If the sky looks smoky, believe the sky \u2014 the Air tab has the details.');
    else lines.push('There\u2019s an official alert up — worth an actual glance before heading out.');
  }else if(cur.code>=95){
    lines.push(pickLine([
      'Sky\u2019s throwing hands today. Maybe don\u2019t be the tallest thing outside.',
      'Thunderstorms around. Free light show, terrible seating.'
    ], 1));
  }else if((cur.code>=71&&cur.code<=77)||cur.code===85||cur.code===86){
    lines.push(pickLine([
      'Snow\u2019s doing its thing. Drive like your deductible depends on it, because it does.',
      'Snow day energy. The shovel knows what it did.'
    ], 1));
  }else if(cur.code>=61){
    lines.push(pickLine([
      'It\u2019s wet out. The ground has called dibs on your socks.',
      'Rain\u2019s here. The wipers are finally earning their keep.',
      'Proper rain today. Good day to be a duck, decent day to be indoors.'
    ], 1));
  }else if(cur.code>=51){
    lines.push(pickLine([
      'Not real rain, just the sky being passive-aggressive.',
      'Drizzle. Too wet to ignore, too weak to respect.'
    ], 1));
  }else if(cur.code===45||cur.code===48){
    lines.push(pickLine([
      'Foggy out. Headlights on, main character mode off.',
      'Visibility\u2019s doing that spooky thing. Drive like everyone else can\u2019t see either, because they can\u2019t.'
    ], 1));
  }else if(cur.code<=1){
    lines.push(pickLine([
      'Zero excuses out there. The sky did its job — your turn.',
      'Sun\u2019s out doing overtime. Go stand in it like a lizard.',
      'Not a cloud with a job in sight.'
    ], 1));
  }else if(cur.code===2){
    lines.push(pickLine([
      'Sun and clouds are splitting custody today.',
      'A few clouds loitering, nothing organized.'
    ], 1));
  }else{
    lines.push(pickLine([
      'The sky picked gray and committed to the bit.',
      'Full blanket mode up there. Cozy or bleak — dealer\u2019s choice.'
    ], 1));
  }

  /* temperature commentary, only when it actually earns a comment */
  if(feels!=null){
    if(feels>=33) lines.push('And it\u2019s stupid hot — hydrate before you evaporate.');
    else if(feels<=-12) lines.push('It\u2019s the kind of cold your car audibly complains about.');
    else if(feels<=-4) lines.push('Genuinely cold. Gloves are not a fashion statement today.');
  }

  if(rain && cur.code<51){
    const when = new Intl.DateTimeFormat('en-US',{hour:'numeric', timeZone:state.tz||undefined}).format(new Date(rain.epochH*3600000));
    lines.push(`Dry for now, but rain shows up around ${when} — plan the errands accordingly.`);
  }else if(!rain && cur.code<51){
    lines.push(pickLine([
      'No rain on the radar for a while. The lawn is on its own.',
      'Nothing wet in the pipeline for the next few hours.'
    ], 2));
  }

  if(aqi!=null && aqi>100) lines.push('Also the air\u2019s a bit chewy today — details on the Air tab.');
  return lines.join(' ');
}
function renderApp(){
  const cur = consensusCurrent();
  const daily = consensusDaily(DAILY_EXTENDED_DAYS);
  const today = daily[0];
  const app = $('#app');
  setTopActions(`
    <button id="saveplace">save</button>
    <button id="openplaces">places</button>
    <button id="shareloc">share</button>
  `);
  app.innerHTML = `
    <div class="locrow">
      <div class="locname">${esc(state.loc.name)}${state.loc.admin?`<span class="sub">${esc(state.loc.admin)}</span>`:''}</div>
      ${renderSkyStrip(today)}
      <button class="linkish" id="changeloc">change location</button>
    </div>
    <div id="placesPanel" class="placespanel hidden"></div>
    ${renderAlerts()}
    <nav class="tabs" role="tablist" aria-label="Forecast views">
      ${TABS.map(t=>
        `<button role="tab" data-tab="${t}" aria-selected="${state.tab===t}">${t==='air'?'Air':t[0].toUpperCase()+t.slice(1)}</button>`).join('')}
    </nav>
    <div class="viewstage" id="viewstage">
      <div class="viewtrack" id="viewtrack">
        <section id="view-current" class="panelview" role="tabpanel"></section>
        <section id="view-hourly" class="panelview" role="tabpanel"></section>
        <section id="view-daily" class="panelview" role="tabpanel"></section>
        <section id="view-radar" class="panelview" role="tabpanel">
          <div class="radarwrap">
            <div class="radarstage" id="radarstage">
              <div class="radarmapframe maplocked" id="radarmapframe">
                <div id="map" aria-label="Precipitation radar map"></div>
                <button class="maptool mapfullscreen" id="mapfullscreen" type="button" aria-label="Open radar fullscreen" title="Fullscreen map">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <button class="maptool maplemon" id="maplemon" type="button" aria-pressed="true" aria-label="Hide location lemon" title="Show or hide location lemon">
                  ${lemonFruit(18, '')}
                </button>
                <button class="maplock" id="maplock" type="button" aria-pressed="true" aria-label="Unlock radar map">
                  <svg class="maplockicon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7.5 10V7.7a4.5 4.5 0 0 1 9 0V10M6 10h12v10H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
                  <span>unlock map</span>
                </button>
                <button class="maptool mapclose" id="mapclose" type="button" aria-label="Exit radar fullscreen" title="Exit fullscreen">×</button>
              </div>
              <div class="radarcontrols">
                <div class="modetoggle basemaptoggle" role="group" aria-label="Radar basemap">
                  <button data-basemap="street" aria-pressed="true">Street</button>
                  <button data-basemap="topo" aria-pressed="false">USGS Topo</button>
                  <button data-basemap="satellite" aria-pressed="false">Satellite</button>
                </div>
                <div class="radarui">
                  <button class="playbtn" id="radarplay" aria-label="Play radar animation">
                    <svg id="playicon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
                  </button>
                  <input class="scrub" id="radarscrub" type="range" min="0" max="0" value="0" aria-label="Radar frame">
                  <span class="frametime" id="radartime">—</span>
                </div>
              </div>
            </div>
            <p class="radarnote" id="radaroutlook"></p>
            <p class="radarnote">Up to 6 hours of radar history in the contiguous U.S., plus the latest RainViewer nowcast.</p>
            <p class="mapcredit">Basemaps © OpenStreetMap · USGS · Esri · radar © RainViewer / Iowa Environmental Mesonet</p>
          </div>
        </section>
        <section id="view-air" class="panelview" role="tabpanel"></section>
      </div>
    </div>`;

  $('#changeloc').addEventListener('click', ()=>{ state.loc = null; state.tab = 'current'; renderLocationScreen(); });
  $('#saveplace').addEventListener('click', saveCurrentPlace);
  $('#openplaces').addEventListener('click', ()=>togglePlacesPanel());
  $('#shareloc').addEventListener('click', shareCurrentLocation);
  app.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', ()=>switchTab(b.dataset.tab)));
  initSwipeNav($('#viewstage'));

  renderCurrent(cur, today);
  renderHourly();
  renderDaily(daily);
  renderAir();
  switchTab(state.tab);
}

/* Today's H/L with a fallback: if no source gave a daily number (common in the
   evening once forecasts roll to "tonight"), derive it from today's hourly blend. */
function todayHiLo(today){
  let hi = today?.hiC ?? null, lo = today?.loC ?? null;
  if(hi==null || lo==null){
    const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
    const dFmt = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined});
    const temps = consensusHourly(24)
      .filter(h => dFmt.format(new Date(h.epochH*3600000)) === todayStr)
      .map(h => h.tempC).filter(t => t!=null);
    const cur = consensusCurrent().tempC;
    if(cur!=null) temps.push(cur);
    if(temps.length){
      if(hi==null) hi = Math.max(...temps);
      if(lo==null) lo = Math.min(...temps);
    }
  }
  /* reality clamp: the day's High can never sit below what it is right now,
     and the Low can never sit above it */
  const nowT = consensusCurrent().tempC;
  if(nowT!=null){
    if(hi!=null) hi = Math.max(hi, nowT);
    if(lo!=null) lo = Math.min(lo, nowT);
  }
  return {hi, lo};
}
function renderCurrent(cur, today){
  const omitted = new Set(cur.omittedIds || []);
  const chips = state.sources.map(s=>{
    if(s.ok===false) return `<span class="chip err">${esc(s.name)}</span>`;
    if(!s.current || s.current.tempC==null) return '';
    const out = omitted.has(s.id);
    return `<span class="chip${out?' outlier':''}"${out?' title="Ignored as an outlier for the current squeeze"':''}>${esc(s.name)} <span class="t">${T(s.current.tempC)}°</span>${out?'<span class="outtag">outlier</span>':''}</span>`;
  }).join('');
  const spread = degSpread(cur.spreadC||0);
  const outCount = Math.max(0,(cur.totalCount||cur.count)-cur.count);
  $('#view-current').innerHTML = `
    <div class="current">
      <div class="bigtemp">${T(cur.tempC)}<sup>°${state.unit}</sup></div>
      <div class="cond">${iconFor(cur.code,30)} ${codeLabel(cur.code)}</div>
      ${(()=>{ const hl = todayHiLo(today); return (hl.hi!=null||hl.lo!=null) ? `<div class="hilo">H ${T(hl.hi)}° · L ${T(hl.lo)}°</div>` : ''; })()}
      <div class="lemonsays"><span>Lemons says</span><p>${esc(lemonsSays(cur, today))}</p></div>
      <div class="statrow">
        <div class="stat"><div class="k">Feels like</div><div class="v">${T(cur.feelsC ?? cur.tempC)}°</div></div>
        <div class="stat"><div class="k">Humidity</div><div class="v">${cur.humidity!=null?Math.round(cur.humidity):'—'}<small>%</small></div></div>
        <div class="stat"><div class="k">Wind</div><div class="v">${W(cur.windKmh)}<small> ${windUnit()}</small></div></div>
      </div>
    </div>
    <div class="opinions">
      <h3>Second opinions</h3>
      <p class="agree">${cur.count}${cur.totalCount&&cur.totalCount!==cur.count?` of ${cur.totalCount}`:''} sources squeezed${outCount?` · <b>${outCount} wild ${outCount===1?'outlier':'outliers'} ignored</b>`:` · they agree within <b>${spread.toFixed(1)}°</b>`}${outCount?` · core spread ${spread.toFixed(1)}°`:''}</p>
      <div class="chips">${chips}</div>
    </div>`;
}

function hourRowDetail(h){ return state.detail?.hourly?.get(h.epochH) || null; }
function isNightHour(h){ const d=hourRowDetail(h); if(d?.isDay!=null) return !d.isDay; const hr=localDateHour(h.epochH).hour; return hr<7||hr>=20; }

function renderHourly(){
  const hours = consensusHourly(state.hourlyHours);
  const timeFmt = new Intl.DateTimeFormat('en-US', {hour:'numeric', timeZone: state.tz || undefined});
  const dayFmt = new Intl.DateTimeFormat('en-US', {weekday:'long', month:'short', day:'numeric', timeZone: state.tz || undefined});
  const counts = hours.map(h=>h.count);
  let lastDate = '';
  $('#view-hourly').innerHTML = `
    <div class="hourlyhead">
      <div><h2>Hourly forecast</h2><p>Tap an hour for the full squeeze.</p></div>
      <div class="hrange" role="group" aria-label="Hourly forecast range">
        ${[24,48,72].map(n=>`<button data-hours="${n}" aria-pressed="${state.hourlyHours===n}">${n}h</button>`).join('')}
      </div>
    </div>
    <div class="hourlist">
      ${hours.map((h,i)=>{
        const d = new Date(h.epochH*3600000), dateKey=localDateForHour(h.epochH), det=hourRowDetail(h);
        const heading = dateKey!==lastDate ? `<div class="hourday">${esc(i===0?'Today · '+dayFmt.format(d):dayFmt.format(d))}</div>` : '';
        lastDate=dateKey;
        const pop=h.precip!=null?Math.round(h.precip):null;
        const amt=det?.precipMm;
        return `${heading}<button class="hourrow${i===0?' now':''}" data-hour="${h.epochH}" aria-label="Open details for ${esc(timeFmt.format(d))}">
          <span class="hourtime">${i===0?'Now':esc(timeFmt.format(d))}</span>
          <span class="houricon">${iconFor(h.code,38,isNightHour(h))}</span>
          <span class="hourtemp">${T(h.tempC)}°</span>
          <span class="hourfeel">Feels ${T(det?.feelsC ?? h.tempC)}°</span>
          <span class="hourprecip">${pop!=null?`<b>◔ ${pop}%</b>`:''}${amt!=null&&amt>0.02?`<small>${P(amt)}</small>`:''}</span>
        </button>`;
      }).join('')}
    </div>
    <p class="blendnote">Headline temperatures average ${counts.length?Math.min(...counts):0}–${counts.length?Math.max(...counts):0} in-family models per hour. A rogue source is dropped automatically before the squeeze.</p>`;
  $('#view-hourly').querySelectorAll('[data-hours]').forEach(b=>b.addEventListener('click', ()=>{
    state.hourlyHours = +b.dataset.hours; store.set('lemons.hourlyHours', state.hourlyHours); renderHourly();
  }));
  $('#view-hourly').querySelectorAll('[data-hour]').forEach(b=>b.addEventListener('click', ()=>openHourlyDetail(+b.dataset.hour)));
}

function renderDaily(daily){
  if(!daily.length){ $('#view-daily').innerHTML = `<div class="msg">No daily data came back.</div>`; return; }
  const monthFmt = new Intl.DateTimeFormat('en-US', {month:'long'});
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
  const normalCount=daily.filter(d=>!d.extended).length, extendedCount=daily.filter(d=>d.extended).length;
  const groups=[];
  daily.forEach(d=>{
    const key=d.date.slice(0,7);
    let g=groups.find(x=>x.key===key);
    if(!g){ g={key,days:[]}; groups.push(g); }
    g.days.push(d);
  });
  const blockHtml=groups.map((g,gi)=>{
    const first=new Date(g.days[0].date+'T12:00:00');
    const blanks=Array.from({length:first.getDay()},()=>'<span class="dayblank" aria-hidden="true"></span>');
    const cells=g.days.map(d=>{
      const dt=new Date(d.date+'T12:00:00');
      const sig=d.extended ? (d.tempSignal==='warmer than normal'?'warmer':d.tempSignal==='cooler than normal'?'cooler':d.precipSignal==='wetter than normal'?'wetter':d.precipSignal==='drier than normal'?'drier':'prediction') : '';
      return `<button class="daycell${d.date===todayStr?' today':''}${d.extended?' extended':''}" data-date="${d.date}" aria-label="Open ${d.extended?'extended prediction':'forecast'} details for ${esc(dt.toDateString())}">
        <span class="daynum">${dt.getDate()}</span>
        ${d.extended?'<span class="predtag">PRED</span>':''}
        ${iconFor(d.code,36,false)}
        <span class="dayhi">${T(d.hiC)}°</span>
        <span class="daylo">${T(d.loC)}°</span>
        ${d.extended?`<span class="daysignal">${esc(sig)}</span>`:(d.precip!=null&&d.precip>=10?`<span class="daypop">${Math.round(d.precip)}%</span>`:'')}
      </button>`;
    });
    const dayCountLabel = `${daily.length} day${daily.length===1?'':'s'}`;
    return `<section class="monthblock${gi?' nextmonth':''}">
      <div class="dailyhead"><div><h2>${esc(monthFmt.format(first))}</h2>${gi===0?`<p>${dayCountLabel} outlook · tap a day for details</p>`:''}</div>${gi===0?`<span>${dayCountLabel}</span>`:''}</div>
      ${gi===0&&extendedCount?`<div class="extendedlegend"><b>${normalCount} days forecast</b><span>then ${extendedCount} days of clearly marked long-range prediction. Those later cells are ECMWF EC46 ensemble guidance — coarse, low confidence, and worth cross-checking with NWS/other sources as the date gets closer.</span></div>`:''}
      <div class="weekdayrow">${['S','M','T','W','T','F','S'].map(x=>`<span>${x}</span>`).join('')}</div>
      <div class="daygrid">${[...blanks,...cells].join('')}</div>
    </section>`;
  }).join('');
  $('#view-daily').innerHTML = `${blockHtml}
    <p class="blendnote">Days 1–${normalCount} use the regular outlier-resistant Lemons squeeze wherever models are available. <b>PRED</b> cells after that are long-range ECMWF EC46 ensemble guidance, not normal day-by-day forecasts. Exact values can move a lot; cross-check other sources before relying on them.</p>`;
  $('#view-daily').querySelectorAll('[data-date]').forEach(b=>b.addEventListener('click', ()=>openDailyDetail(b.dataset.date)));
}

function metricRow(label, value, cls=''){
  if(value==null || value==='—' || value==='') return '';
  return `<div class="detailrow"><span>${esc(label)}</span><b class="${cls}">${value}</b></div>`;
}
function detailModalShell(title, subtitle, body){
  closeForecastDetail();
  const el=document.createElement('div'); el.id='forecastDetail'; el.className='forecastdetail';
  el.innerHTML=`<div class="detailinner"><div class="detailtop"><button id="detailClose" class="detailclose" aria-label="Close">×</button><div><strong>${esc(title)}</strong>${subtitle?`<small>${esc(subtitle)}</small>`:''}</div></div><div id="detailBody">${body}</div></div>`;
  document.body.appendChild(el); document.body.style.overflow='hidden';
  $('#detailClose').addEventListener('click', closeForecastDetail);
  document.addEventListener('keydown', forecastDetailEsc);
  return el;
}
function closeForecastDetail(){ const el=$('#forecastDetail'); if(el) el.remove(); document.body.style.overflow=''; document.removeEventListener('keydown', forecastDetailEsc); }
function forecastDetailEsc(e){ if(e.key==='Escape') closeForecastDetail(); }

function openHourlyDetail(epochH){
  const h = consensusHourly(Math.max(1,epochH-Math.floor(Date.now()/3600000)+1)).find(x=>x.epochH===epochH);
  if(!h) return;
  const d=state.detail?.hourly?.get(epochH)||{};
  const dt=new Date(epochH*3600000);
  const title=new Intl.DateTimeFormat('en-US',{hour:'numeric',weekday:'long',timeZone:state.tz||undefined}).format(dt);
  const subtitle=new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',timeZone:state.tz||undefined}).format(dt);
  const precip=h.precip ?? d.precip;
  const airHour=(state.air?.hourly||[]).find(x=>x.epochH===epochH);
  const body=`<div class="detailhero">
      ${iconFor(h.code,76,isNightHour(h))}<div class="detailtemp">${T(h.tempC)}°</div>
      <div class="detailprecip">${precip!=null?`Precipitation: ${Math.round(precip)}%`:''}</div>
      <div class="detailcond">${esc(codeLabel(h.code))}</div>
    </div>
    <div class="detailrows">
      ${metricRow('Feels like', `${T(d.feelsC ?? h.tempC)}°${state.unit}`)}
      ${metricRow('Humidity', d.humidity!=null?`${Math.round(d.humidity)}%`:'—')}
      ${metricRow('Air quality', airHour?.aqi!=null?`${Math.round(airHour.aqi)} AQI · ${esc(aqiLabel(airHour.aqi))}`:'—')}
      ${metricRow('Wind', windText(d.windKmh,d.windDir))}
      ${metricRow('Wind gusts', d.gustKmh!=null?`${W(d.gustKmh)} ${windUnit()}`:'—')}
      ${metricRow('Precipitation probability', precip!=null?`${Math.round(precip)}%`:'—')}
      ${metricRow(d.snowCm>0?'Snow amount':'Rain amount', d.snowCm>0?SNOW(d.snowCm):P(d.rainMm ?? d.precipMm))}
      ${metricRow('Cloud cover', d.cloud!=null?`${Math.round(d.cloud)}%`:'—')}
      ${metricRow('Dew point', d.dewC!=null?`${T(d.dewC)}°${state.unit}`:'—')}
      ${metricRow('Visibility', visText(d.visibilityM))}
      ${metricRow('Pressure', d.pressureHpa!=null?`${Math.round(d.pressureHpa)} hPa`:'—')}
    </div><p class="detailnote">Temperature and precipitation headline = Lemons multi-source squeeze. Secondary metrics = local best-match detail feed.</p>`;
  detailModalShell(title, subtitle, body);
}

function dayHourlySlice(date, night=false){
  const out=[];
  state.detail?.hourly?.forEach((r,h)=>{ if(localDateForHour(h)!==date) return; const day=r.isDay!=null?!!r.isDay:(localDateHour(h).hour>=7&&localDateHour(h).hour<20); if(night?!day:day) out.push(r); });
  return out;
}
function summarizePeriod(date, night=false){
  const arr=dayHourlySlice(date,night), d=state.detail?.daily?.get(date)||{};
  const hasHourly = arr.length>0;
  const gustVals=arr.map(x=>x.gustKmh).filter(x=>x!=null);
  const precipVals=arr.map(x=>x.precip).filter(x=>x!=null);
  return {
    feelsC: night ? (d.feelsLoC ?? (hasHourly?avg(arr.map(x=>x.feelsC)):null)) : (d.feelsHiC ?? (hasHourly?avg(arr.map(x=>x.feelsC)):null)),
    windKmh: hasHourly ? (avg(arr.map(x=>x.windKmh)) ?? d.windKmh ?? null) : (d.windKmh ?? null),
    windDir: hasHourly ? (median(arr.map(x=>x.windDir)) ?? d.windDir ?? null) : (d.windDir ?? null),
    gustKmh: gustVals.length ? Math.max(...gustVals, d.gustKmh??-Infinity) : (d.gustKmh ?? null),
    cloud: hasHourly ? avg(arr.map(x=>x.cloud)) : null,
    precip: precipVals.length ? Math.max(...precipVals, d.precip??-Infinity) : (d.precip ?? null),
    rainMm: hasHourly ? arr.reduce((a,x)=>a+(x.rainMm||0),0) : (!night ? (d.rainMm ?? null) : null),
    snowCm: hasHourly ? arr.reduce((a,x)=>a+(x.snowCm||0),0) : (!night ? (d.snowCm ?? null) : null),
    precipHours: hasHourly ? arr.filter(x=>(x.precipMm||0)>0.05).length : (!night ? (d.precipHours ?? null) : null),
    humidity: hasHourly ? avg(arr.map(x=>x.humidity)) : null,
    dewC: hasHourly ? avg(arr.map(x=>x.dewC)) : null
  };
}
function safeMax(v){ return v===-Infinity?null:v; }

function openExtendedDailyDetail(day){
  const date=day.date, dt=new Date(date+'T12:00:00');
  const subtitle=new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric'}).format(dt);
  const signalBits=[day.tempSignal,day.precipSignal].filter(Boolean).join(' · ');
  const tempAnom = day.tempAnomC!=null ? `${day.tempAnomC>0?'+':''}${(state.unit==='F' ? day.tempAnomC*9/5 : day.tempAnomC).toFixed(1)}°${state.unit}` : null;
  const precipAmount = day.precipMm!=null ? P(day.precipMm) : null;
  detailModalShell(state.loc.name, subtitle, `<div class="detailtabs extendedtabs" role="tablist"><button data-dtab="outlook" aria-selected="true">Outlook</button><button data-dtab="history" aria-selected="false">History</button></div><div id="dailyDetailContent"></div>`);
  const renderOutlook=()=>{
    const el=$('#dailyDetailContent'); if(!el) return;
    el.innerHTML=`<div class="extendedwarning"><b>Extended prediction — not a normal forecast</b><span>This is coarse ensemble guidance this far out. Exact day-to-day weather can change a lot.</span></div>
      <div class="detailhero dailyhero extendedhero">${iconFor(day.code,68,false)}<div class="extendedrange"><b>${T(day.hiC)}°</b><span>/</span><b>${T(day.loC)}°</b></div><div class="detailcond">${esc(signalBits || codeLabel(day.code))}</div></div>
      <div class="detailrows">
        ${metricRow('Model mean high', day.hiC!=null?`${T(day.hiC)}°${state.unit}`:'—')}
        ${metricRow('Model mean low', day.loC!=null?`${T(day.loC)}°${state.unit}`:'—')}
        ${metricRow('Temperature signal', day.tempSignal?`${esc(day.tempSignal)}${tempAnom?` · ${tempAnom}`:''}`:'—')}
        ${metricRow('Precipitation signal', day.precipSignal?esc(day.precipSignal):'—')}
        ${metricRow('Model precipitation', precipAmount)}
        ${metricRow('Confidence', esc(day.confidence||'very low'))}
      </div>
      <div class="extendedsource"><b>What this is</b><p>ECMWF EC46 ensemble-mean guidance at roughly 36 km resolution. Lemons does not blend this into the regular 16-day forecast, and it should be read as a broad pattern prediction — not a promise that this exact high, low or icon will happen on this exact date.</p><p><strong>Cross-check it.</strong> As this date gets closer, use the normal Lemons squeeze plus weather.gov/NWS and another independent source before making plans.</p><div class="extendedlinks"><a href="https://www.weather.gov/" target="_blank" rel="noopener">weather.gov ↗</a><a href="https://www.cpc.ncep.noaa.gov/" target="_blank" rel="noopener">NOAA climate outlooks ↗</a></div></div>`;
  };
  $('#forecastDetail').querySelectorAll('[data-dtab]').forEach(b=>b.addEventListener('click',async()=>{
    const tab=b.dataset.dtab;
    $('#forecastDetail').querySelectorAll('[data-dtab]').forEach(x=>x.setAttribute('aria-selected',x.dataset.dtab===tab));
    if(tab==='history') await renderHistoryTab(date,day); else renderOutlook();
  }));
  renderOutlook();
}

function openDailyDetail(date){
  const day=consensusDaily(DAILY_EXTENDED_DAYS).find(x=>x.date===date); if(!day) return;
  if(day.extended){ openExtendedDailyDetail(day); return; }
  const dt=new Date(date+'T12:00:00');
  const title=state.loc.name;
  const subtitle=new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric'}).format(dt);
  detailModalShell(title, subtitle, `<div class="detailtabs" role="tablist"><button data-dtab="day" aria-selected="true">Day</button><button data-dtab="night" aria-selected="false">Night</button><button data-dtab="history" aria-selected="false">History</button></div><div id="dailyDetailContent"></div>`);
  const renderTab=async tab=>{
    $('#forecastDetail').querySelectorAll('[data-dtab]').forEach(b=>b.setAttribute('aria-selected',b.dataset.dtab===tab));
    if(tab==='history'){ await renderHistoryTab(date,day); return; }
    const night=tab==='night', sum=summarizePeriod(date,night), det=state.detail?.daily?.get(date)||{};
    sum.gustKmh=safeMax(sum.gustKmh); sum.precip=safeMax(sum.precip);
    const temp=night?day.loC:day.hiC, code=det.code??day.code, pop=sum.precip??day.precip;
    const amount=sum.snowCm>0?SNOW(sum.snowCm):P(sum.rainMm || (night?null:det.rainMm));
    const sunMoon = night
      ? `<div class="celestial"><span class="sectioncap">Moon</span>${metricRow('Moon phase', moonPhaseAt(dt).name)}${metricRow('Illumination', `${Math.round(moonPhaseAt(dt).frac*100)}%`)}</div>`
      : `<div class="celestial"><span class="sectioncap">Sun</span>${metricRow('Rise', det.sunrise?skyTime(det.sunrise):'—')}${metricRow('Set', det.sunset?skyTime(det.sunset):'—')}${metricRow('Total daylight', durText(det.daylightSec))}</div>`;
    $('#dailyDetailContent').innerHTML=`<div class="detailhero dailyhero">${iconFor(code,76,night)}<div class="detailtemp">${T(temp)}°</div><div class="detailprecip">${pop!=null?`Precipitation: ${Math.round(pop)}%`:''}</div><div class="detailcond">${esc(codeLabel(code))}</div></div>
      <div class="detailrows">
        ${metricRow('Feels like', sum.feelsC!=null?`${T(sum.feelsC)}°${state.unit}`:'—')}
        ${metricRow('Humidity', sum.humidity!=null?`${Math.round(sum.humidity)}%`:'—')}
        ${metricRow('Wind', windText(sum.windKmh,sum.windDir))}
        ${metricRow('Max wind gusts', sum.gustKmh!=null?`${W(sum.gustKmh)} ${windUnit()}`:'—')}
        ${metricRow('Total hours of precipitation', sum.precipHours!=null?`${sum.precipHours} hr${sum.precipHours===1?'':'s'}`:'—')}
        ${metricRow('Precipitation probability', pop!=null?`${Math.round(pop)}%`:'—')}
        ${metricRow(sum.snowCm>0?'Snow amount':'Rain amount', amount)}
        ${!night?metricRow('Max UV index', det.uv!=null?`${det.uv.toFixed(1)}${det.uv<3?' (Low)':det.uv<6?' (Moderate)':det.uv<8?' (High)':' (Very high)'}`:'—'):''}
        ${metricRow('Cloud cover', sum.cloud!=null?`${Math.round(sum.cloud)}%`:'—')}
        ${metricRow('Dew point', sum.dewC!=null?`${T(sum.dewC)}°${state.unit}`:'—')}
      </div>${sunMoon}`;
  };
  $('#forecastDetail').querySelectorAll('[data-dtab]').forEach(b=>b.addEventListener('click',()=>renderTab(b.dataset.dtab)));
  renderTab('day');
}

function moonPhaseAt(dateLike){
  const at = dateLike instanceof Date ? dateLike.getTime() : new Date(dateLike).getTime();
  const synodic=29.530588853, days=at/86400000-Date.UTC(2000,0,6,18,14)/86400000;
  const age=((days%synodic)+synodic)%synodic, frac=(1-Math.cos(2*Math.PI*age/synodic))/2, waxing=age<synodic/2;
  const name=frac<0.06?'New moon':frac<0.35?(waxing?'Waxing crescent':'Waning crescent'):frac<0.65?(waxing?'First quarter':'Last quarter'):frac<0.94?(waxing?'Waxing gibbous':'Waning gibbous'):'Full moon';
  return {age,frac,waxing,name};
}

const HISTORY_FIRST_YEAR = 1940;
const HISTORY_PAGE_YEARS = 10;
const HISTORY_CHART_W = 1000;
let historyRenderSeq = 0;
let historyChartModes = {temp:'line', rain:'line'};
let historyChartSelectionYears = {temp:null, rain:null};

function historyInitialEndYear(date){
  return Math.max(HISTORY_FIRST_YEAR, Math.min(new Date(date+'T12:00:00').getFullYear()-1, new Date().getFullYear()));
}
function historyPageBounds(endYear){
  const end=Math.max(HISTORY_FIRST_YEAR,Math.round(endYear));
  return {startYear:Math.max(HISTORY_FIRST_YEAR,end-HISTORY_PAGE_YEARS+1),endYear:end};
}
function historyTempValue(c){ return c==null?null:(state.unit==='F'?cToF(c):c); }
function historyRainValue(mm){ return mm==null?null:(state.unit==='F'?mm/25.4:mm); }
function historyRainUnit(){ return state.unit==='F'?'in':'mm'; }
function historyTempUnit(){ return `°${state.unit}`; }
function historyActive(){ return !!$('#dailyDetailContent') && !!$('#forecastDetail [data-dtab="history"][aria-selected="true"]'); }
function historyLoadingMarkup(){
  return `<div class="historyskeleton" aria-live="polite" aria-label="Loading weather history">
    <div class="historyskline wide"></div><div class="historyskline"></div><div class="historyskchart"></div>
    <div class="historyskline short"></div><div class="historyskrow"></div><div class="historyskrow"></div><div class="historyskrow"></div>
    <p class="historyloadcopy">Gathering the full same-date record…</p>
  </div>`;
}
async function fetchHistoryPage(date,endYear){
  const target=new Date(date+'T12:00:00'), month=target.getMonth(), day=target.getDate();
  const b=historyPageBounds(endYear);
  const key=`page:${state.loc.lat.toFixed(3)},${state.loc.lon.toFixed(3)}:${month+1}-${day}:${b.startYear}-${b.endYear}`;
  if(state.historyCache[key]) return state.historyCache[key];
  const start=`${b.startYear}-01-01`;
  /* ERA5 trails real time by several days. Clamp a page that reaches the current
     year so a late-December request never asks the archive for future dates. */
  const safeArchive=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  const end=(`${b.endYear}-12-31`<safeArchive)?`${b.endYear}-12-31`:safeArchive;
  try{
    /* ERA5 is deliberately pinned here instead of Open-Meteo "best match" so a
       1940-vs-2020 comparison uses one consistent reanalysis record. */
    const vars='weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,rain_sum,snowfall_sum';
    const url=`https://archive-api.open-meteo.com/v1/archive?latitude=${state.loc.lat}&longitude=${state.loc.lon}&start_date=${start}&end_date=${end}&daily=${vars}&timezone=auto&models=era5`;
    const d=await fetchJSON(url,{},24000);
    const rows=[];
    (d.daily?.time||[]).forEach((ds,i)=>{
      const x=new Date(ds+'T12:00:00');
      if(x.getMonth()!==month || x.getDate()!==day) return;
      rows.push({
        date:ds,year:x.getFullYear(),
        code:d.daily.weather_code?.[i]??null,
        hiC:d.daily.temperature_2m_max?.[i]??null,
        loC:d.daily.temperature_2m_min?.[i]??null,
        precipMm:d.daily.precipitation_sum?.[i]??null,
        rainMm:d.daily.rain_sum?.[i]??null,
        snowCm:d.daily.snowfall_sum?.[i]??null
      });
    });
    const out={...b,rows,count:rows.length,avgHiC:avg(rows.map(r=>r.hiC)),avgLoC:avg(rows.map(r=>r.loC))};
    state.historyCache[key]=out;
    return out;
  }catch(e){ return null; }
}
async function fetchAllHistory(date){
  const target=new Date(date+'T12:00:00'), month=target.getMonth(), day=target.getDate();
  const initialEnd=historyInitialEndYear(date);
  const key=`all:${state.loc.lat.toFixed(3)},${state.loc.lon.toFixed(3)}:${month+1}-${day}:${initialEnd}`;
  if(state.historyCache[key]) return state.historyCache[key];
  const ends=[];
  for(let end=initialEnd; end>=HISTORY_FIRST_YEAR; end-=HISTORY_PAGE_YEARS) ends.push(end);
  const pages=new Array(ends.length);
  let cursor=0;
  const workers=Array.from({length:Math.min(3,ends.length)},async()=>{
    while(cursor<ends.length){
      const i=cursor++;
      pages[i]=await fetchHistoryPage(date,ends[i]);
    }
  });
  await Promise.all(workers);
  const byYear=new Map();
  pages.filter(Boolean).forEach(page=>page.rows.forEach(r=>{
    if(!byYear.has(r.year)) byYear.set(r.year,r);
  }));
  const rows=[...byYear.values()].sort((a,b)=>a.year-b.year);
  if(!rows.length) return null;
  const out={
    rows,
    count:rows.length,
    firstYear:rows[0].year,
    lastYear:rows[rows.length-1].year,
    partial:pages.some(p=>!p)
  };
  state.historyCache[key]=out;
  return out;
}
function historyDateLabel(ds){
  const d=new Date(ds+'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(d);
}
function historyNiceTicks(min,max,target=6){
  if(!isFinite(min)||!isFinite(max)) return [0,1];
  if(min===max){ min-=1; max+=1; }
  const span=Math.max(1e-9,max-min), raw=span/Math.max(2,target-1), p=Math.pow(10,Math.floor(Math.log10(raw)));
  const candidates=[1,2,2.5,5,10].map(v=>v*p);
  const step=candidates.reduce((best,v)=>Math.abs(v-raw)<Math.abs(best-raw)?v:best,candidates[0]);
  const lo=Math.floor(min/step)*step, hi=Math.ceil(max/step)*step;
  const ticks=[];
  for(let v=lo,n=0; v<=hi+step*.1 && n<12; v+=step,n++) ticks.push(+v.toFixed(6));
  return ticks.length>=2?ticks:[lo,hi];
}
function historyChartToggle(kind,mode){
  return `<button type="button" data-history-chart="${kind}" data-history-mode="${mode}" aria-pressed="${historyChartModes[kind]===mode}">${mode[0].toUpperCase()+mode.slice(1)}</button>`;
}
function historyXAxisMarks(pts,x,H,B,W){
  if(!pts.length) return {ticks:'',labels:''};
  const maxLabels=8;
  const every=Math.max(1,Math.ceil((pts.length-1)/Math.max(1,maxLabels-1)));
  const chosen=[];
  pts.forEach((r,i)=>{ if(i===0 || i===pts.length-1 || i%every===0) chosen.push({r,i}); });
  const ticks=chosen.map(({i})=>`<line class="hchartxtick" x1="${x(i)}" x2="${x(i)}" y1="${H-B}" y2="${H-B+5}"/>`).join('');
  const labels=chosen.map(({r,i},n)=>{
    const pct=100*x(i)/W, edge=n===0?' first':n===chosen.length-1?' last':'';
    return `<span class="hchartxlabel${edge}" style="left:${pct}%">${r.year}</span>`;
  }).join('');
  return {ticks,labels};
}
function historyTempChartBody(rows,mode=historyChartModes.temp){
  const pts=rows.filter(r=>r.hiC!=null||r.loC!=null).sort((a,b)=>a.year-b.year);
  if(!pts.length) return '<div class="historychartempty">No temperature record came back for this date.</div>';
  const H=248,T0=16,B=42,PX=10,W=HISTORY_CHART_W, plotW=W, ih=H-T0-B;
  const vals=pts.flatMap(r=>[historyTempValue(r.hiC),historyTempValue(r.loC)]).filter(v=>v!=null&&isFinite(v));
  let dataMin=Math.min(...vals), dataMax=Math.max(...vals);
  const pad=Math.max(3,(dataMax-dataMin)*.08);
  const ticks=historyNiceTicks(dataMin-pad,dataMax+pad,8), min=ticks[0], max=ticks[ticks.length-1];
  const x=i=>pts.length===1?plotW/2:PX+i*(plotW-PX*2)/(pts.length-1), y=v=>T0+(max-v)*ih/(max-min||1);
  const tempFmt=v=>`${Number.isInteger(v)?v:v.toFixed(1)}${historyTempUnit()}`;
  const grid=ticks.map(v=>`<line class="hchartgrid" x1="0" x2="${plotW}" y1="${y(v)}" y2="${y(v)}"/>`).join('');
  const axis=ticks.map(v=>`<text class="hchartylabel" x="51" y="${y(v)+4}" text-anchor="end">${tempFmt(v)}</text>`).join('');
  const xAxis=historyXAxisMarks(pts,x,H,B,W);
  const pathFor=k=>{ let started=false; return pts.map((r,i)=>{ const v=historyTempValue(r[k]); if(v==null) return null; const cmd=started?'L':'M'; started=true; return `${cmd}${x(i).toFixed(1)},${y(v).toFixed(1)}`; }).filter(Boolean).join(' '); };
  let marks='';
  if(mode==='bar'){
    const spacing=pts.length>1?(plotW-PX*2)/(pts.length-1):26, bw=Math.max(1.4,Math.min(7.5,spacing*.28)), base=y(min);
    marks=pts.map((r,i)=>{
      const hi=historyTempValue(r.hiC), lo=historyTempValue(r.loC), cx=x(i);
      const a=hi==null?'':`<rect class="htempbar hi" x="${cx-bw-0.7}" y="${y(hi)}" width="${bw}" height="${Math.max(1,base-y(hi))}" rx="1"/>`;
      const b=lo==null?'':`<rect class="htempbar lo" x="${cx+0.7}" y="${y(lo)}" width="${bw}" height="${Math.max(1,base-y(lo))}" rx="1"/>`;
      return a+b;
    }).join('');
  }else if(mode==='area'){
    const valid=pts.map((r,i)=>({i,hi:historyTempValue(r.hiC),lo:historyTempValue(r.loC)})).filter(r=>r.hi!=null&&r.lo!=null);
    const band=valid.length>1?`M${valid.map(r=>`${x(r.i)},${y(r.hi)}`).join(' L')} L${[...valid].reverse().map(r=>`${x(r.i)},${y(r.lo)}`).join(' L')} Z`:'';
    marks=`${band?`<path class="hchartarea temprange" d="${band}"/>`:''}<path class="hchartline hi" d="${pathFor('hiC')}"/><path class="hchartline lo" d="${pathFor('loC')}"/>`;
  }else{
    marks=`<path class="hchartline hi" d="${pathFor('hiC')}"/><path class="hchartline lo" d="${pathFor('loC')}"/>`;
  }
  return `<div class="historychartframe"><svg class="historyyaxis" viewBox="0 0 58 ${H}" aria-hidden="true">${axis}<text class="hchartaxisunit" x="51" y="11" text-anchor="end">${historyTempUnit()}</text></svg><div class="historyplotviewport historyplotinteractive" data-history-kind="temp" data-plot-w="${W}" data-plot-h="${H}" data-plot-left="${PX}" data-plot-right="${plotW-PX}" data-y-min="${min}" data-y-max="${max}" data-plot-top="${T0}" data-plot-bottom="${H-B}" tabindex="0" role="slider" aria-valuemin="${pts[0].year}" aria-valuemax="${pts[pts.length-1].year}" aria-label="Temperature history graph. Tap or drag across the graph to inspect any year."><div class="historyplotsurface"><svg class="historyplot" viewBox="0 0 ${plotW} ${H}" preserveAspectRatio="none" role="img" aria-label="High and low temperature for every available ${historyDateLabel(pts[0].date).replace(/,?\s*\d{4}$/,'')} record from ${pts[0].year} through ${pts[pts.length-1].year}">${grid}<line class="hchartbaseline" x1="0" x2="${plotW}" y1="${H-B}" y2="${H-B}"/>${marks}${xAxis.ticks}</svg><div class="historyxlabels">${xAxis.labels}</div><div class="historyscrub" aria-hidden="true"><div class="historyscrubband"></div><div class="historyscrubline"></div><i class="historyscrubdot temp-hi"></i><i class="historyscrubdot temp-lo"></i><div class="historycharttip"><b></b><span></span></div></div></div></div></div>`;
}
function historyRainChartBody(rows,mode=historyChartModes.rain){
  const pts=[...rows].filter(r=>r.rainMm!=null).sort((a,b)=>a.year-b.year);
  if(!pts.length) return '<div class="historychartempty">Rainfall was not available for this date.</div>';
  const H=232,T0=16,B=42,PX=10,W=HISTORY_CHART_W, plotW=W, ih=H-T0-B;
  const vals=pts.map(r=>historyRainValue(r.rainMm)).filter(v=>v!=null&&isFinite(v)), maxVal=Math.max(0,...vals);
  const floorMax=state.unit==='F'?.1:2;
  const ticks=historyNiceTicks(0,Math.max(maxVal*1.08,floorMax),7).filter(v=>v>=0);
  const min=0,max=Math.max(...ticks), y=v=>T0+(max-v)*ih/(max||1), x=i=>pts.length===1?plotW/2:PX+i*(plotW-PX*2)/(pts.length-1);
  const rainFmt=v=>`${v.toFixed(state.unit==='F'?(v<1?2:1):(v<10?1:0))} ${historyRainUnit()}`;
  const grid=ticks.map(v=>`<line class="hchartgrid" x1="0" x2="${plotW}" y1="${y(v)}" y2="${y(v)}"/>`).join('');
  const axis=ticks.map(v=>`<text class="hchartylabel" x="51" y="${y(v)+4}" text-anchor="end">${rainFmt(v)}</text>`).join('');
  const xAxis=historyXAxisMarks(pts,x,H,B,W);
  const path=pts.map((r,i)=>`${i?'L':'M'}${x(i).toFixed(1)},${y(historyRainValue(r.rainMm)).toFixed(1)}`).join(' ');
  let marks='';
  if(mode==='bar'){
    const spacing=pts.length>1?(plotW-PX*2)/(pts.length-1):24, bw=Math.max(1.7,Math.min(9,spacing*.54)), base=y(0);
    marks=pts.map((r,i)=>{ const v=historyRainValue(r.rainMm), yy=y(v); return `<rect class="hrainbar" x="${x(i)-bw/2}" y="${yy}" width="${bw}" height="${Math.max(1,base-yy)}" rx="1"/>`; }).join('');
  }else if(mode==='area'){
    const first=x(0),last=x(pts.length-1),base=y(0), area=`M${first},${base} L${pts.map((r,i)=>`${x(i)},${y(historyRainValue(r.rainMm))}`).join(' L')} L${last},${base} Z`;
    marks=`<path class="hchartarea rain" d="${area}"/><path class="hchartline rain" d="${path}"/>`;
  }else{
    marks=`<path class="hchartline rain" d="${path}"/>`;
  }
  return `<div class="historychartframe"><svg class="historyyaxis" viewBox="0 0 58 ${H}" aria-hidden="true">${axis}<text class="hchartaxisunit" x="51" y="11" text-anchor="end">${historyRainUnit()}</text></svg><div class="historyplotviewport historyplotinteractive" data-history-kind="rain" data-plot-w="${W}" data-plot-h="${H}" data-plot-left="${PX}" data-plot-right="${plotW-PX}" data-y-min="${min}" data-y-max="${max}" data-plot-top="${T0}" data-plot-bottom="${H-B}" tabindex="0" role="slider" aria-valuemin="${pts[0].year}" aria-valuemax="${pts[pts.length-1].year}" aria-label="Rainfall history graph. Tap or drag across the graph to inspect any year."><div class="historyplotsurface"><svg class="historyplot" viewBox="0 0 ${plotW} ${H}" preserveAspectRatio="none" role="img" aria-label="Rainfall for every available same-date record from ${pts[0].year} through ${pts[pts.length-1].year}">${grid}<line class="hchartbaseline" x1="0" x2="${plotW}" y1="${H-B}" y2="${H-B}"/>${marks}${xAxis.ticks}</svg><div class="historyxlabels">${xAxis.labels}</div><div class="historyscrub" aria-hidden="true"><div class="historyscrubband"></div><div class="historyscrubline"></div><i class="historyscrubdot rain"></i><div class="historycharttip"><b></b><span></span></div></div></div></div></div>`;
}
function historyTempChart(rows){
  return `<section class="historychart" data-history-chart-shell="temp"><div class="historycharthead"><div><h3>Temperature</h3><p>${historyTempUnit()} · all ${rows.filter(r=>r.hiC!=null||r.loC!=null).length} records · tap or drag to inspect</p></div><div class="historychartmeta"><div class="historylegend"><span><i class="hi"></i>High</span><span><i class="lo"></i>Low</span></div><div class="historycharttypes" role="group" aria-label="Temperature graph type">${historyChartToggle('temp','line')}${historyChartToggle('temp','bar')}${historyChartToggle('temp','area')}</div></div></div><div class="historychartbody">${historyTempChartBody(rows)}</div></section>`;
}
function historyRainChart(rows){
  return `<section class="historychart" data-history-chart-shell="rain"><div class="historycharthead"><div><h3>Rainfall</h3><p>${historyRainUnit()} · all ${rows.filter(r=>r.rainMm!=null).length} records · tap or drag to inspect</p></div><div class="historychartmeta"><span class="historyunit">${historyRainUnit()}</span><div class="historycharttypes" role="group" aria-label="Rainfall graph type">${historyChartToggle('rain','line')}${historyChartToggle('rain','bar')}${historyChartToggle('rain','area')}</div></div></div><div class="historychartbody">${historyRainChartBody(rows)}</div></section>`;
}
function historyRowsMarkup(rows){
  const ordered=[...rows].sort((a,b)=>b.year-a.year);
  return `<section class="historyyears"><div class="historyyearsintro"><div><h3>Year by year</h3><p>${ordered.length} available same-date records · newest to oldest</p></div><span>${ordered.length?`${ordered[ordered.length-1].year}–${ordered[0].year}`:''}</span></div><div class="historyyearshead"><span>Date</span><span>Weather</span><b>High <small>${historyTempUnit()}</small></b><b>Low <small>${historyTempUnit()}</small></b><b>Rain <small>${historyRainUnit()}</small></b></div>${ordered.map(r=>`<div class="historyyearrow">
    <strong><span>${r.year}</span><small>${esc(historyDateLabel(r.date).replace(/,?\s*\d{4}$/,''))}</small></strong><span class="historywx">${iconFor(r.code,28,false)}<span>${esc(codeLabel(r.code))}${r.snowCm>0?`<small>${esc(SNOW(r.snowCm))} snow</small>`:''}</span></span>
    <b>${r.hiC!=null?`${T(r.hiC)}°`:'—'}</b><b>${r.loC!=null?`${T(r.loC)}°`:'—'}</b><b>${r.rainMm!=null?P(r.rainMm):'—'}</b>
  </div>`).join('')}</section>`;
}
function historySetPlotToNewest(){ /* charts now fit the full record with no horizontal scrolling */ }
function historyChartPoints(kind,rows){
  return kind==='temp'
    ? rows.filter(r=>r.hiC!=null||r.loC!=null).sort((a,b)=>a.year-b.year)
    : rows.filter(r=>r.rainMm!=null).sort((a,b)=>a.year-b.year);
}
function setupHistoryGraphScrubber(kind,rows,shell){
  const viewport=shell?.querySelector('.historyplotinteractive');
  const surface=viewport?.querySelector('.historyplotsurface');
  const scrub=viewport?.querySelector('.historyscrub');
  if(!viewport||!surface||!scrub) return;
  const pts=historyChartPoints(kind,rows); if(!pts.length) return;
  const W=Number(viewport.dataset.plotW)||HISTORY_CHART_W,
        H=Number(viewport.dataset.plotH)||240,
        left=Number(viewport.dataset.plotLeft)||10,
        right=Number(viewport.dataset.plotRight)||W-10,
        ymin=Number(viewport.dataset.yMin)||0,
        ymax=Number(viewport.dataset.yMax)||1,
        top=Number(viewport.dataset.plotTop)||16,
        bottom=Number(viewport.dataset.plotBottom)||H-42;
  const line=scrub.querySelector('.historyscrubline'), band=scrub.querySelector('.historyscrubband'), tip=scrub.querySelector('.historycharttip');
  const tipDate=tip?.querySelector('b'), tipValue=tip?.querySelector('span');
  const dotHi=scrub.querySelector('.temp-hi'), dotLo=scrub.querySelector('.temp-lo'), dotRain=scrub.querySelector('.historyscrubdot.rain');
  const xFor=i=>pts.length===1?W/2:left+i*(right-left)/(pts.length-1);
  const yFor=v=>top+(ymax-v)*(bottom-top)/(ymax-ymin||1);
  const pctX=i=>100*xFor(i)/W;
  const pctY=v=>100*yFor(v)/H;
  const setDot=(dot,v,xp)=>{
    if(!dot||v==null||!isFinite(v)){ if(dot) dot.hidden=true; return; }
    dot.hidden=false; dot.style.left=`${xp}%`; dot.style.top=`${pctY(v)}%`;
  };
  let raf=0,pending=-1,dragging=false,dragRect=null;
  function paint(i){
    i=Math.max(0,Math.min(pts.length-1,i));
    const r=pts[i], xp=pctX(i), clampedTip=Math.max(18,Math.min(82,xp));
    scrub.classList.add('is-active');
    line.style.left=`${xp}%`; band.style.left=`${xp}%`; tip.style.left=`${clampedTip}%`;
    tipDate.textContent=historyDateLabel(r.date);
    if(kind==='temp'){
      const hi=historyTempValue(r.hiC), lo=historyTempValue(r.loC);
      setDot(dotHi,hi,xp); setDot(dotLo,lo,xp);
      const parts=[];
      if(hi!=null) parts.push(`High ${Number.isInteger(hi)?hi:hi.toFixed(1)}${historyTempUnit()}`);
      if(lo!=null) parts.push(`Low ${Number.isInteger(lo)?lo:lo.toFixed(1)}${historyTempUnit()}`);
      tipValue.textContent=parts.join('  ·  ')||'No temperature value';
    }else{
      const rain=historyRainValue(r.rainMm); setDot(dotRain,rain,xp);
      tipValue.textContent=rain==null?'No rainfall value':`Rain ${rain.toFixed(state.unit==='F'?(rain<1?2:1):(rain<10?1:0))} ${historyRainUnit()}`;
    }
    historyChartSelectionYears[kind]=r.year;
    viewport.setAttribute('aria-valuenow',String(r.year));
    viewport.setAttribute('aria-valuetext',`${historyDateLabel(r.date)}. ${tipValue.textContent}`);
  }
  function schedule(i){ pending=i; if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; paint(pending); }); }
  function indexFromEvent(e){
    const rect=dragRect||surface.getBoundingClientRect();
    const frac=Math.max(0,Math.min(1,(e.clientX-rect.left)/Math.max(1,rect.width)));
    const coord=frac*W;
    return Math.max(0,Math.min(pts.length-1,Math.round((coord-left)/Math.max(1,right-left)*(pts.length-1))));
  }
  viewport.addEventListener('pointerdown',e=>{
    dragging=true; dragRect=surface.getBoundingClientRect(); viewport.classList.add('is-scrubbing');
    try{ viewport.setPointerCapture(e.pointerId); }catch(_e){}
    schedule(indexFromEvent(e));
  });
  viewport.addEventListener('pointermove',e=>{
    if(dragging || e.pointerType==='mouse') schedule(indexFromEvent(e));
  });
  const endDrag=e=>{ dragging=false; dragRect=null; viewport.classList.remove('is-scrubbing'); try{ viewport.releasePointerCapture(e.pointerId); }catch(_e){} };
  viewport.addEventListener('pointerup',endDrag); viewport.addEventListener('pointercancel',endDrag);
  viewport.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault();
    const currentYear=historyChartSelectionYears[kind], current=Math.max(0,pts.findIndex(r=>r.year===currentYear));
    let next=current;
    if(e.key==='ArrowLeft') next=Math.max(0,current-1);
    if(e.key==='ArrowRight') next=Math.min(pts.length-1,current+1);
    if(e.key==='Home') next=0;
    if(e.key==='End') next=pts.length-1;
    schedule(next);
  });
  const remembered=historyChartSelectionYears[kind];
  if(remembered!=null){ const i=pts.findIndex(r=>r.year===remembered); if(i>=0) requestAnimationFrame(()=>paint(i)); }
}
function setupHistoryChartControls(rows,root){
  root.querySelectorAll('[data-history-chart][data-history-mode]').forEach(btn=>btn.addEventListener('click',()=>{
    const kind=btn.dataset.historyChart, mode=btn.dataset.historyMode;
    if(!['line','bar','area'].includes(mode)||!['temp','rain'].includes(kind)) return;
    const shell=root.querySelector(`[data-history-chart-shell="${kind}"]`);
    historyChartModes[kind]=mode;
    shell?.querySelectorAll('[data-history-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.historyMode===mode)));
    const body=shell?.querySelector('.historychartbody');
    if(body) body.innerHTML=kind==='temp'?historyTempChartBody(rows,mode):historyRainChartBody(rows,mode);
    setupHistoryGraphScrubber(kind,rows,shell);
  }));
  ['temp','rain'].forEach(kind=>setupHistoryGraphScrubber(kind,rows,root.querySelector(`[data-history-chart-shell="${kind}"]`)));
}
async function renderHistoryPage(date,day){
  const el=$('#dailyDetailContent'); if(!el) return;
  const seq=++historyRenderSeq;
  historyChartModes={temp:'line',rain:'line'};
  historyChartSelectionYears={temp:null,rain:null};
  el.innerHTML=historyLoadingMarkup(); el.setAttribute('aria-busy','true');
  const archive=await fetchAllHistory(date);
  if(seq!==historyRenderSeq || !historyActive()) return;
  if(!archive){
    el.removeAttribute('aria-busy');
    el.innerHTML=`<div class="historyerror"><b>History did not come back for this spot.</b><span>Check your connection, then try the full record again.</span><button class="linkish" id="historyRetry">retry</button></div>`;
    $('#historyRetry')?.addEventListener('click',()=>renderHistoryPage(date,day));
    return;
  }
  const rows=archive.rows, newest=[...rows].sort((a,b)=>b.year-a.year), recentRows=newest.slice(0,10), latest=newest[0]||null;
  const avgHi=avg(recentRows.map(r=>r.hiC)), avgLo=avg(recentRows.map(r=>r.loC));
  const initialEnd=historyInitialEndYear(date), exactLast=rows.find(r=>r.year===initialEnd)||null;
  const lastRow=exactLast||latest;
  const lastLabel=exactLast?'Last year on this date':(lastRow?`Most recent same-date record · ${lastRow.year}`:'Most recent same-date record');
  el.removeAttribute('aria-busy');
  el.innerHTML=`<div class="historytable"><div class="historyhead"><span></span><b>High <small>${historyTempUnit()}</small></b><b>Low <small>${historyTempUnit()}</small></b></div>
    <div><span>${day.extended?'Extended model estimate':'This forecast'}</span><b>${T(day.hiC)}°</b><b>${T(day.loC)}°</b></div>
    ${recentRows.length?`<div><span>Recent same-date avg <small>(${recentRows.length} records)</small></span><b>${T(avgHi)}°</b><b>${T(avgLo)}°</b></div>`:''}
    ${lastRow?`<div><span>${esc(lastLabel)}</span><b>${T(lastRow.hiC)}°</b><b>${T(lastRow.loC)}°</b></div>`:''}
  </div>
  <div class="historyarchive">
    <div class="historyarchiveintro"><div><h2>Same-date archive</h2><p>${archive.count} records from ${archive.firstYear}–${archive.lastYear}${archive.partial?' · some archive slices were unavailable':''}</p></div><span>${historyDateLabel(rows[0].date).replace(/,?\s*\d{4}$/,'')}</span></div>
    ${historyTempChart(rows)}
    ${historyRainChart(rows)}
    ${historyRowsMarkup(rows)}
  </div>
  <p class="detailnote historynote">Historical rows use Open-Meteo's ERA5 reanalysis for this exact calendar date. ERA5 is a consistent gridded reconstruction rather than an official weather-station log. Missing years are simply omitted; the record ends at the oldest date the archive returns.</p>`;
  setupHistoryChartControls(rows,el);
}
async function renderHistoryTab(date,day){
  return renderHistoryPage(date,day);
}

function aqiLabel(v){
  if(v==null) return 'Unknown';
  if(v<=50) return 'Good';
  if(v<=100) return 'Moderate';
  if(v<=150) return 'Unhealthy for sensitive folks';
  if(v<=200) return 'Unhealthy';
  if(v<=300) return 'Very unhealthy';
  return 'Hazardous';
}
function pollenLabel(v){
  if(v==null) return '—';
  if(v<=1) return 'barely there';
  if(v<=15) return 'low';
  if(v<=50) return 'medium';
  return 'high';
}
function airSays(a){
  if(smokeAlertActive() && a.source !== 'ground'){
    return 'There\u2019s an active air quality alert, and this reading comes from a model that regularly misses smoke. Believe the sky and the ground sensors over this number \u2014 limit time outside.';
  }
  const cur = consensusCurrent();
  const aqi = a.aqi;
  const lines = [];
  if(aqi==null){
    lines.push('No score came back, so officially the air is a mystery. Breathe at your own pace.');
  }else if(aqi<=50){
    lines.push(pickLine([
      'Air\u2019s basically filtered today. Breathe as much as you want, it\u2019s free.',
      'Clean air, no notes.',
      'The air passed inspection. Lungs may proceed.'
    ], 7));
  }else if(aqi<=100){
    lines.push(pickLine([
      'Air\u2019s mid but breathable. You\u2019ve inhaled worse at a bonfire.',
      'Not spa-grade air, but it\u2019ll do the job.'
    ], 7));
  }else if(aqi<=150){
    lines.push(pickLine([
      'A bit chewy out there — sensitive lungs get a heads-up, everyone else carry on.',
      'The air has texture today. If your lungs are picky, keep the hard cardio inside.'
    ], 7));
  }else{
    lines.push(pickLine([
      'Air\u2019s genuinely junky right now. Great day for indoor hobbies.',
      'The air is doing crimes. Windows shut, blender on, make lemonade instead.'
    ], 7));
  }
  /* tie it to what the sky is doing */
  if(cur.code!=null && cur.code>=61 && cur.code<95) lines.push('Upside: the rain is rinsing the air as we speak.');
  else if(cur.windKmh!=null && cur.windKmh>=22) lines.push('The wind\u2019s out here doing free duct cleaning, so it should keep moving.');
  else if(aqi!=null && aqi>100 && cur.code!=null && cur.code<=1) lines.push('Still air and sunshine means it\u2019ll probably sit like this a while.');
  /* pollen callout only when it matters */
  const loud = (a.pollen||[]).find(([,v]) => v!=null && v>50);
  if(loud) lines.push(`Pollen-wise, ${loud[0].toLowerCase()} is the loudest one out today — allergies, brace.`);
  return lines.join(' ');
}
function renderAir(){
  const a = state.air;
  if(!a || !a.ok){
    $('#view-air').innerHTML = `<div class="msg"><h2>Air read is being shy.</h2>Air quality or pollen data did not come back for this spot.</div>`;
    return;
  }
  const topPollen = (a.pollen || []).slice(0,4);
  const timeFmt = new Intl.DateTimeFormat('en-US', {hour:'numeric', timeZone: state.tz || undefined});
  const hourlyAir = (a.hourly||[]).filter((_,i)=>i%3===0).slice(0,8);
  $('#view-air').innerHTML = `
    <div class="airwrap">
      <div class="aircurrent">
        <div class="airlabel">Air quality</div>
        <div class="bigtemp airscore">${a.aqi!=null?Math.round(a.aqi):'—'}<sup>AQI</sup></div>
        <div class="cond">${lemonFruit(22, 'Air quality')} ${esc(aqiLabel(a.aqi))}</div>
        ${a.dominant ? `<div class="hilo">driven by ${esc(a.dominant)} \u00b7 ${a.source==='ground' ? ('AirNow ground monitors' + (a.obsLabel ? ' \u00b7 ' + esc(a.obsLabel) + ' obs' : '')) : 'NowCast \u00b7 model'}</div>` : ''}
        <div class="lemonsays"><span>Lemons says</span><p>${esc(airSays(a))}</p></div>
        <div class="hilo"></div>
        ${(a.source==='ground' && a.groundPollutants && a.groundPollutants.length) ? `<div class="statrow airstats">
          ${a.groundPollutants.map(p=>`<div class="stat"><div class="k">${esc(p.name)}</div><div class="v">${Math.round(p.aqi)}<small> AQI</small></div></div>`).join('')}
        </div>` : `<div class="statrow airstats">
          <div class="stat"><div class="k">PM2.5</div><div class="v">${a.pm25!=null?Math.round(a.pm25):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">PM10</div><div class="v">${a.pm10!=null?Math.round(a.pm10):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">Ozone</div><div class="v">${a.ozone!=null?Math.round(a.ozone):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">NO₂</div><div class="v">${a.no2!=null?Math.round(a.no2):'—'}<small> µg/m³</small></div></div>
        </div>`}
      </div>

      ${topPollen.length ? `<div class="airsection">
        <h3>Pollen count</h3>
        <div class="airrows">
          ${topPollen.map(([name,val])=>`<div class="airrowline"><span>${esc(name)}</span><b>${esc(pollenLabel(val))}</b><small>${Math.round(val)} grains/m³</small></div>`).join('')}
        </div>
      </div>` : ''}

      <div class="airsection">
        <h3>Air through the day</h3>
        <div class="airtimeline">
          ${hourlyAir.length ? hourlyAir.map(h=>`<div class="airtimeitem"><span>${esc(timeFmt.format(new Date(h.epochH*3600000)))}</span><b>${h.aqi!=null?Math.round(h.aqi):'—'}</b><small>AQI</small></div>`).join('') : '<p class="airnone">No hourly air read came back.</p>'}
        </div>
      </div>

      <div class="airsection">
        <h3>Smoke map</h3>
        <img id="smokeimg" alt="NOAA HRRR near-surface smoke forecast" loading="lazy">
        <p class="blendnote" id="smokenote">NOAA HRRR-Smoke \u00b7 <a href="https://rapidrefresh.noaa.gov/hrrr/HRRRsmoke/" target="_blank" rel="noopener">open the full viewer with forecast loops</a></p>
      </div>

      <p class="blendnote">${a.source==='ground' ? 'Headline and pollutant numbers are live EPA/AirNow ground-monitor readings \u2014 the same feed as airnow.gov. Observations post hourly, so a fast-moving hour can briefly differ from their gauge.' : (topPollen.length ? 'AQI and pollen use the Open-Meteo air-quality feed. Pollen can be patchy by region, so treat it as a clean heads-up, not a medical-grade read.' : 'AQI computed here with EPA NowCast + 2024 breakpoints from CAMS model data. During heavy smoke, ground sensors (AirNow) can still read worse than any model.')}</p>
    </div>`;
  initSmokeMap();
}

/* ---------- mobile swipe between sections ---------- */
let swipeCtl = null;

function initSwipeNav(stage){
  if(!stage) return;
  const track = stage.querySelector('.viewtrack');
  const panels = [...stage.querySelectorAll('.panelview')];
  const nav = document.querySelector('nav.tabs');
  if(!track || !panels.length || !nav) return;

  if(swipeCtl?.destroy) swipeCtl.destroy();

  let index = Math.max(0, TABS.indexOf(state.tab));
  let tracking = false, horizontal = false;
  let startX = 0, startY = 0, lastX = 0, lastT = 0, velocityX = 0;
  let width = Math.max(1, stage.clientWidth);
  let raf = 0, pendingDx = 0, trackX = 0, suppressClickUntil = 0;

  const ignored = target => !!target.closest(
    'input,select,textarea,a,.hrange button,.basemaptoggle button,.playbtn,.maplock,.maptool,.hscroll,.airtimeline,.scrub,.forecastdetail'
  );
  const panelHeight = i => Math.max(1, panels[i]?.scrollHeight || 1);
  const xFor = (i, dx=0) => -i * width + dx;
  const setTrack = (x, animate=false, duration=240) => {
    track.style.transition = animate ? `transform ${duration}ms cubic-bezier(.22,1,.36,1)` : 'none';
    trackX = x;
    track.style.transform = `translate3d(${x}px,0,0)`;
  };
  const setHeight = (h, animate=false, duration=220) => {
    stage.style.transition = animate ? `height ${duration}ms cubic-bezier(.22,1,.36,1)` : 'none';
    stage.style.height = `${Math.max(1, Math.ceil(h))}px`;
  };
  const setIndicator = (pos, dragging=false) => {
    nav.classList.toggle('swiping', dragging);
    nav.style.setProperty('--tab-x', `${pos * (100/TABS.length)}%`);
  };
  const updateAria = i => {
    document.querySelectorAll('nav.tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===TABS[i]));
    panels.forEach((p,pi)=>{
      p.classList.toggle('active', pi===i);
      p.setAttribute('aria-hidden', pi===i ? 'false' : 'true');
    });
  };
  const maybeInitNeighbor = dx => {
    const dir = dx < 0 ? 1 : -1;
    const ni = index + dir;
    if(ni>=0 && ni<TABS.length && TABS[ni]==='radar') initRadar();
  };
  const renderDrag = dx => {
    width = Math.max(1, stage.clientWidth);
    let applied = dx;
    if((index===0 && dx>0) || (index===TABS.length-1 && dx<0)) applied = dx * 0.22;
    setTrack(xFor(index, applied), false);

    const rawPos = index - applied/width;
    setIndicator(Math.max(0, Math.min(TABS.length-1, rawPos)), true);

    const dir = applied < 0 ? 1 : -1;
    const ni = index + dir;
    if(ni>=0 && ni<TABS.length){
      const p = Math.min(1, Math.abs(applied)/width);
      const h = panelHeight(index) + (panelHeight(ni)-panelHeight(index))*p;
      setHeight(h, false);
    }
  };
  const settle = (nextIndex, fromDrag=true) => {
    nextIndex = Math.max(0, Math.min(TABS.length-1, nextIndex));
    index = nextIndex;
    state.tab = TABS[index];
    updateAria(index);
    setIndicator(index, false);

    const dist = Math.abs(xFor(index)-trackX);
    const duration = fromDrag ? Math.max(150, Math.min(270, 150 + dist/width*130)) : 250;
    setTrack(xFor(index), true, duration);
    setHeight(panelHeight(index), true, Math.min(duration,230));

    if(state.tab==='radar'){
      initRadar();
      setTimeout(()=>state.radar?.map?.invalidateSize(), duration+30);
    }
  };

  const onStart = e => {
    if(e.touches.length!==1 || ignored(e.target)) return;
    /* An unlocked Leaflet map owns its gestures. A locked map has pointer-events
       disabled, so the event lands on the frame and naturally becomes section swipe. */
    if(e.target.closest('#map,.leaflet-container')) return;
    tracking = true; horizontal = false;
    startX = lastX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastT = performance.now(); velocityX = 0;
    track.style.transition = 'none';
    stage.style.transition = 'none';
  };
  const onMove = e => {
    if(!tracking || e.touches.length!==1) return;
    const x=e.touches[0].clientX, y=e.touches[0].clientY;
    const dx=x-startX, dy=y-startY;
    if(!horizontal){
      if(Math.abs(dx)<7 && Math.abs(dy)<7) return;
      if(Math.abs(dy)>Math.abs(dx)*1.05){ tracking=false; return; }
      horizontal=true;
      stage.classList.add('dragging');
      maybeInitNeighbor(dx);
    }
    e.preventDefault();
    const now=performance.now(), dt=Math.max(1,now-lastT);
    velocityX = velocityX*.55 + ((x-lastX)/dt)*.45;
    lastX=x; lastT=now;
    pendingDx=dx;
    if(!raf) raf=requestAnimationFrame(()=>{ raf=0; renderDrag(pendingDx); });
  };
  const finish = e => {
    if(!tracking && !horizontal) return;
    const wasHorizontal=horizontal;
    tracking=false; horizontal=false; stage.classList.remove('dragging');
    if(!wasHorizontal){ setIndicator(index,false); return; }
    const endX = e.changedTouches?.[0]?.clientX ?? lastX;
    const dx=endX-startX;
    if(Math.abs(dx)>10) suppressClickUntil = performance.now()+360;
    const travel=Math.abs(dx)/Math.max(1,width);
    const flick=Math.abs(velocityX)>0.42;
    let next=index;
    if((travel>0.18 || flick) && Math.abs(dx)>24){
      next = dx<0 ? index+1 : index-1;
    }
    settle(next,true);
  };
  const onCancel = ()=>{
    if(!tracking && !horizontal) return;
    tracking=false; horizontal=false; stage.classList.remove('dragging');
    settle(index,true);
  };
  const onResize = ()=>{
    width=Math.max(1,stage.clientWidth);
    setTrack(xFor(index),false);
    setHeight(panelHeight(index),false);
  };

  const onClickCapture = e=>{
    if(performance.now() < suppressClickUntil){ e.preventDefault(); e.stopPropagation(); }
  };
  stage.addEventListener('click',onClickCapture,true);
  stage.addEventListener('touchstart',onStart,{passive:true});
  stage.addEventListener('touchmove',onMove,{passive:false});
  stage.addEventListener('touchend',finish,{passive:true});
  stage.addEventListener('touchcancel',onCancel,{passive:true});
  window.addEventListener('resize',onResize,{passive:true});

  const ro = typeof ResizeObserver!=='undefined' ? new ResizeObserver(entries=>{
    for(const entry of entries){
      const pi=panels.indexOf(entry.target);
      if(pi===index && !horizontal) setHeight(panelHeight(index),false);
    }
  }) : null;
  panels.forEach(p=>ro?.observe(p));

  swipeCtl = {
    go(tab){
      const ni=TABS.indexOf(tab); if(ni<0) return;
      if(ni===index){
        state.tab=tab; updateAria(index); setIndicator(index,false); setHeight(panelHeight(index),false);
        if(tab==='radar') initRadar();
        return;
      }
      if(tab==='radar') initRadar();
      settle(ni,false);
    },
    refresh(){ onResize(); },
    destroy(){
      if(raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      stage.removeEventListener('click',onClickCapture,true);
      stage.removeEventListener('touchstart',onStart);
      stage.removeEventListener('touchmove',onMove);
      stage.removeEventListener('touchend',finish);
      stage.removeEventListener('touchcancel',onCancel);
      window.removeEventListener('resize',onResize);
    }
  };

  updateAria(index);
  setIndicator(index,false);
  requestAnimationFrame(()=>onResize());
}

/* ---------- tabs ---------- */
function switchTab(tab){
  if(!TABS.includes(tab)) return;
  state.tab = tab;
  if(swipeCtl){ swipeCtl.go(tab,true); return; }
  document.querySelectorAll('nav.tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===tab));
  document.querySelectorAll('.panelview').forEach(p=>p.classList.toggle('active',p.id==='view-'+tab));
  if(tab==='radar') initRadar();
}

/* ---------- radar (Leaflet + RainViewer) ---------- */
function initRadar(){
  if(state.radar){ state.radar.map.invalidateSize(); return; }
  if(typeof L === 'undefined'){ $('#map').innerHTML = '<p class="msg">Map library failed to load.</p>'; return; }

  const map = L.map('map', {zoomControl:true, attributionControl:true, minZoom:1}).setView([state.loc.lat, state.loc.lon], 7);
  setTimeout(()=>map.invalidateSize(), 80);

  /* Keep the animated RainViewer layer independent from the basemap.  Custom
     panes guarantee that switching maps can never cover the precipitation. */
  map.createPane('lemonsBase');
  map.getPane('lemonsBase').style.zIndex = 200;
  map.createPane('lemonsRadar');
  map.getPane('lemonsRadar').style.zIndex = 380;
  map.getPane('lemonsRadar').style.pointerEvents = 'none';
  map.createPane('lemonsMarker');
  map.getPane('lemonsMarker').style.zIndex = 520;

  const basemaps = {
    street: L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      pane:'lemonsBase', subdomains:'abc', maxNativeZoom:19, maxZoom:19,
      attribution:'&copy; OpenStreetMap contributors · tiles &copy; HOT / OpenStreetMap France'
    }),
    topo: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      pane:'lemonsBase', maxNativeZoom:17, maxZoom:19,
      attribution:'Tiles courtesy of the U.S. Geological Survey'
    }),
    satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      pane:'lemonsBase', maxZoom:19,
      attribution:'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    })
  };

  const savedBase = store.get('lemons.radarBase', 'street');
  let baseName = basemaps[savedBase] ? savedBase : 'street';
  basemaps[baseName].addTo(map);

  const lemonMarkerIcon = L.divIcon({
    className:'lemonmapmarker',
    html:lemonFruit(30, state.loc.name || 'Forecast location'),
    iconSize:[30,30], iconAnchor:[15,15]
  });
  const locationMarker = L.marker([state.loc.lat, state.loc.lon], {
    pane:'lemonsMarker', icon:lemonMarkerIcon, interactive:false, keyboard:false
  });
  const markerVisible = store.get('lemons.radarPinVisible') !== false;
  if(markerVisible) locationMarker.addTo(map);

  const radar = state.radar = {
    map, frames:[], layers:{}, layerMeta:{}, layerIndex:{}, basemaps, baseName, idx:0, displayedIdx:-1, desiredIdx:0,
    playing:false, timer:null, frameRaf:null, swapTimer:null, moveTimer:null, locked:true, scrubbing:false,
    activeLayer:null, pendingLayer:null, pendingIdx:-1, swapSeq:0,
    locationMarker, markerVisible, fsHandler:null, fitHandler:null, orientationHandler:null,
    fitWidth:0, fallbackFullscreen:false, fsPlaceholder:null,
    hotIndices:new Set(), hotRadius:2, preloadGen:0, preloadQueue:[], preloadActive:0, preloadConcurrency:4, bgStarted:false,
    destroy(){
      clearTimeout(this.timer); clearTimeout(this.swapTimer); clearTimeout(this.moveTimer);
      if(this.frameRaf) cancelAnimationFrame(this.frameRaf);
      this.preloadGen++;
      if(this.fsHandler){
        document.removeEventListener('fullscreenchange', this.fsHandler);
        document.removeEventListener('webkitfullscreenchange', this.fsHandler);
      }
      if(this.fitHandler) window.removeEventListener('resize', this.fitHandler);
      if(this.orientationHandler) window.removeEventListener('orientationchange', this.orientationHandler);
      restoreFallbackFullscreen();
      this.map.remove();
    }
  };

  /* LemonCoords-style gesture lock: locked by default so a swipe over the map
     belongs to section navigation. Unlocking hands every gesture back to Leaflet. */
  const mapFrame = $('#radarmapframe');
  const mapLock = $('#maplock');
  const lockIcon = locked => locked
    ? '<svg class="maplockicon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7.5 10V7.7a4.5 4.5 0 0 1 9 0V10M6 10h12v10H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg class="maplockicon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M15.8 10V7.7a4.5 4.5 0 0 0-8.3-2.4M6 10h12v10H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function setMapLocked(locked){
    radar.locked = !!locked;
    mapFrame?.classList.toggle('maplocked', radar.locked);
    if(mapLock){
      mapLock.setAttribute('aria-pressed', radar.locked ? 'true' : 'false');
      mapLock.setAttribute('aria-label', radar.locked ? 'Unlock radar map' : 'Lock radar map');
      mapLock.innerHTML = `${lockIcon(radar.locked)}<span>${radar.locked ? 'unlock map' : 'lock map'}</span>`;
    }
    const method = radar.locked ? 'disable' : 'enable';
    map.dragging?.[method]();
    map.touchZoom?.[method]();
    map.doubleClickZoom?.[method]();
    map.scrollWheelZoom?.[method]();
    map.boxZoom?.[method]();
    map.keyboard?.[method]();
  }
  mapLock?.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation();
    setMapLocked(!radar.locked);
  });
  setMapLocked(true);

  /* Location lemon: the forecast point itself, not the browser/device location. */
  const lemonToggle = $('#maplemon');
  function setMarkerVisible(show){
    radar.markerVisible = !!show;
    if(radar.markerVisible){
      if(!map.hasLayer(radar.locationMarker)) radar.locationMarker.addTo(map);
    }else if(map.hasLayer(radar.locationMarker)){
      map.removeLayer(radar.locationMarker);
    }
    store.set('lemons.radarPinVisible', radar.markerVisible);
    if(lemonToggle){
      lemonToggle.setAttribute('aria-pressed', radar.markerVisible ? 'true' : 'false');
      lemonToggle.setAttribute('aria-label', radar.markerVisible ? 'Hide location lemon' : 'Show location lemon');
      lemonToggle.title = radar.markerVisible ? 'Hide location lemon' : 'Show location lemon';
    }
  }
  lemonToggle?.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation();
    setMarkerVisible(!radar.markerVisible);
  });
  setMarkerVisible(radar.markerVisible);

  /* Fullscreen the map + its basemap buttons + timeline as one unit. */
  const radarStage = $('#radarstage');
  const fsButton = $('#mapfullscreen');
  const fsClose = $('#mapclose');
  const enterFsIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const exitFsIcon = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const fullscreenElement = ()=>document.fullscreenElement || document.webkitFullscreenElement || null;

  /* Keep the normal radar console entirely above the fold. We measure the
     actual remaining viewport instead of guessing with vh, then freeze that
     height so browser chrome / scrolling cannot make the map jump around. */
  function fitRadarStage(force=false){
    if(!radarStage) return;
    const activeFs = fullscreenElement()===radarStage || radar.fallbackFullscreen;
    if(activeFs) return;

    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    /* Mobile address-bar show/hide fires resize events without a real layout
       change. Ignore those; only refit for a meaningful width/orientation change. */
    if(!force && radar.fitWidth && Math.abs(width-radar.fitWidth) < 40) return;
    radar.fitWidth = width;

    const viewportH = window.innerHeight || document.documentElement.clientHeight || 720;
    const stageTop = Math.max(0, radarStage.getBoundingClientRect().top);
    const controls = radarStage.querySelector('.radarcontrols');
    const controlsH = Math.ceil(controls?.getBoundingClientRect().height || 82);
    const bottomBreathingRoom = 8;
    const available = Math.max(controlsH + 250, viewportH - stageTop - bottomBreathingRoom);
    const preferred = controlsH + 520;
    const stageH = Math.min(preferred, available);

    radarStage.style.setProperty('--radar-stage-h', `${Math.round(stageH)}px`);
    radarStage.classList.add('radarfit');
    requestAnimationFrame(()=>map.invalidateSize());
  }

  radar.fitHandler = ()=>fitRadarStage(false);
  radar.orientationHandler = ()=>setTimeout(()=>fitRadarStage(true), 90);
  window.addEventListener('resize', radar.fitHandler, {passive:true});
  window.addEventListener('orientationchange', radar.orientationHandler, {passive:true});
  requestAnimationFrame(()=>fitRadarStage(true));
  setTimeout(()=>fitRadarStage(true), 120);

  function restoreFallbackFullscreen(){
    if(!radar.fallbackFullscreen) return;
    radar.fallbackFullscreen = false;
    radarStage?.classList.remove('isfullscreen');
    if(radar.fsPlaceholder?.parentNode && radarStage){
      radar.fsPlaceholder.parentNode.insertBefore(radarStage, radar.fsPlaceholder);
      radar.fsPlaceholder.remove();
    }
    radar.fsPlaceholder = null;
  }
  function syncFullscreen(){
    const active = fullscreenElement()===radarStage || radar.fallbackFullscreen;
    if(fsButton){
      fsButton.innerHTML = active ? exitFsIcon : enterFsIcon;
      fsButton.setAttribute('aria-label', active ? 'Exit radar fullscreen' : 'Open radar fullscreen');
      fsButton.title = active ? 'Exit fullscreen' : 'Fullscreen map';
      fsButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if(!active) fitRadarStage(true);
    requestAnimationFrame(()=>{
      map.invalidateSize();
      setTimeout(()=>map.invalidateSize(), 120);
    });
  }
  function enterFallbackFullscreen(){
    if(!radarStage || radar.fallbackFullscreen) return;
    radar.fsPlaceholder = document.createComment('lemons-radar-fullscreen');
    radarStage.parentNode?.insertBefore(radar.fsPlaceholder, radarStage);
    document.body.appendChild(radarStage);
    radar.fallbackFullscreen = true;
    radarStage.classList.add('isfullscreen');
  }
  async function enterFullscreen(){
    if(!radarStage) return;
    try{
      if(radarStage.requestFullscreen) await radarStage.requestFullscreen();
      else if(radarStage.webkitRequestFullscreen) radarStage.webkitRequestFullscreen();
      else enterFallbackFullscreen();
    }catch(e){ enterFallbackFullscreen(); }
    syncFullscreen();
  }
  async function exitFullscreen(){
    try{
      if(fullscreenElement() && document.exitFullscreen) await document.exitFullscreen();
      else if(fullscreenElement() && document.webkitExitFullscreen) document.webkitExitFullscreen();
      else restoreFallbackFullscreen();
    }catch(e){ restoreFallbackFullscreen(); }
    syncFullscreen();
  }
  function toggleFullscreen(e){
    e?.preventDefault(); e?.stopPropagation();
    const active = fullscreenElement()===radarStage || radar.fallbackFullscreen;
    active ? exitFullscreen() : enterFullscreen();
  }
  fsButton?.addEventListener('click', toggleFullscreen);
  fsClose?.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); exitFullscreen(); });
  radar.fsHandler = syncFullscreen;
  document.addEventListener('fullscreenchange', radar.fsHandler);
  document.addEventListener('webkitfullscreenchange', radar.fsHandler);

  function setBasemap(name){
    if(!radar.basemaps[name] || radar.baseName===name) return;
    Object.entries(radar.basemaps).forEach(([key, layer])=>{
      if(key===name){
        if(!map.hasLayer(layer)) layer.addTo(map);
      }else if(map.hasLayer(layer)){
        map.removeLayer(layer);
      }
    });
    radar.baseName = name;
    store.set('lemons.radarBase', name);
    document.querySelectorAll('[data-basemap]').forEach(btn=>{
      btn.setAttribute('aria-pressed', btn.dataset.basemap===name);
    });
    /* Reassert radar opacity after a base switch; the custom pane keeps it on top. */
    if(radar.activeLayer) radar.activeLayer.setOpacity(0.75);
  }

  document.querySelectorAll('[data-basemap]').forEach(btn=>{
    btn.setAttribute('aria-pressed', btn.dataset.basemap===baseName);
    btn.addEventListener('click', ()=>setBasemap(btn.dataset.basemap));
  });

  fetchJSON('https://api.rainviewer.com/public/weather-maps.json').then(d=>{
    const rvPast = (d.radar?.past||[]).map(f=>({...f, provider:'rainviewer'}));
    const rvNowcast = (d.radar?.nowcast||[]).map(f=>({...f, provider:'rainviewer'}));
    radar.host = d.host || 'https://tilecache.rainviewer.com';

    /* RainViewer's public tiled timeline exposes only the latest two hours.
       In the contiguous U.S., fill the older side of the slider out to six hours
       with Iowa Environmental Mesonet's time-aware NEXRAD mosaic archive. */
    const inConus = state.loc.lat >= 24 && state.loc.lat <= 50 && state.loc.lon >= -125 && state.loc.lon <= -66;
    let extended = [];
    if(inConus && rvPast.length){
      const step = 10 * 60;
      const earliestRv = rvPast[0].time;
      const cutoff = Math.floor((Date.now()/1000 - 6*3600) / step) * step;
      for(let t=cutoff; t < earliestRv; t += step){
        extended.push({time:t, path:`iem-${t}`, provider:'iem'});
      }
    }

    radar.frames = [...extended, ...rvPast, ...rvNowcast];
    radar.startIdx = Math.max(0, extended.length + rvPast.length - 1);
    radar.desiredIdx = radar.startIdx;

    const scrub = $('#radarscrub');
    const beginScrub = ()=>{
      if(!radar.scrubbing){
        radar.scrubbing = true;
        stopTimelinePreload();
      }
      stopRadar();
    };
    const endScrub = ()=>{
      if(!radar.scrubbing) return;
      radar.scrubbing = false;
      showFrame(+scrub.value);
      startTimelinePreload(+scrub.value);
    };
    scrub.addEventListener('pointerdown', beginScrub);
    scrub.addEventListener('input', ()=>{
      beginScrub();
      queueFrame(+scrub.value);
    });
    scrub.addEventListener('pointerup', endScrub);
    scrub.addEventListener('pointercancel', endScrub);
    scrub.addEventListener('change', endScrub);
    $('#radarplay').addEventListener('click', ()=> radar.playing ? stopRadar() : playRadar());

    if(!radar.frames.length){
      $('#radartime').textContent = 'no data';
      scrub.max = 0;
      return;
    }
    scrub.max = radar.frames.length-1;
    showFrame(radar.startIdx);
  }).catch(()=>{ $('#radartime').textContent = 'radar offline'; });

  /* rain outlook: Open-Meteo 15-minute nowcast — "rain around 4:15" under the map */
  fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${state.loc.lat}&longitude=${state.loc.lon}&minutely_15=precipitation&forecast_minutely_15=24&timezone=auto`)
    .then(d=>{
      const el = $('#radaroutlook'); if(!el) return;
      const times = d.minutely_15?.time || [], vals = d.minutely_15?.precipitation || [];
      const nowMs = Date.now();
      let firstRain = null, rainingNow = false;
      for(let i=0;i<times.length;i++){
        const t = Date.parse(times[i]);
        if(t + 15*60000 < nowMs) continue;
        if(vals[i] != null && vals[i] > 0.1){
          if(t <= nowMs){ rainingNow = true; break; }
          firstRain = t; break;
        }
      }
      const fmt = new Intl.DateTimeFormat('en-US', {hour:'numeric', minute:'2-digit', timeZone: state.tz || undefined});
      el.textContent = rainingNow ? 'Precipitation over the spot right now.'
        : firstRain ? `Next precipitation near here around ${fmt.format(new Date(firstRain))}.`
        : 'Nothing hitting this spot in the next 6 hours.';
    }).catch(()=>{});

  function layerKey(f){
    return f.provider === 'iem' ? `iem:${f.time}` : `rv:${f.path}`;
  }

  function metaFor(i){
    const f = radar.frames[i];
    if(!f) return null;
    const key = layerKey(f);
    layerFor(i);
    return radar.layerMeta[key] || null;
  }

  function layerFor(i){
    const f = radar.frames[i];
    if(!f) return null;
    const key = layerKey(f);
    if(!radar.layers[key]){
      let layer;
      if(f.provider === 'iem'){
        layer = L.tileLayer.wms('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r-t.cgi', {
          layers:'nexrad-n0r-wmst',
          time:new Date(f.time*1000).toISOString(),
          format:'image/png', transparent:true,
          pane:'lemonsRadar', opacity:0,
          minZoom:1, maxZoom:19,
          updateWhenIdle:true, updateWhenZooming:false, keepBuffer:0,
          attribution:'Older U.S. radar &copy; Iowa Environmental Mesonet'
        });
      }else{
        layer = L.tileLayer(`${radar.host}${f.path}/512/{z}/{x}/{y}/2/1_1.png`, {
          pane:'lemonsRadar', opacity:0, tileSize:512, zoomOffset:-1,
          minZoom:1, maxNativeZoom:8, maxZoom:19, noWrap:true,
          updateWhenIdle:true, updateWhenZooming:false, keepBuffer:0,
          crossOrigin:true, attribution:'Radar &copy; RainViewer'
        });
      }
      const meta = radar.layerMeta[key] = {
        index:i, ready:false, warmed:false, promise:null, preloading:false
      };
      layer.on('loading', ()=>{ meta.ready = false; });
      layer.on('load', ()=>{ meta.ready = true; meta.warmed = true; });
      radar.layers[key] = layer;
      radar.layerIndex[key] = i;
    }
    return radar.layers[key];
  }

  function indexForLayer(layer){
    if(!layer) return -1;
    for(const [key, value] of Object.entries(radar.layers)){
      if(value === layer) return radar.layerIndex[key] ?? -1;
    }
    return -1;
  }

  function detachFrame(i){
    const layer = layerFor(i);
    const meta = metaFor(i);
    if(layer && map.hasLayer(layer) && layer!==radar.activeLayer && layer!==radar.pendingLayer){
      map.removeLayer(layer);
      if(meta) meta.ready = false;
    }
  }

  function shouldKeepFrame(i, layer){
    return layer===radar.activeLayer || layer===radar.pendingLayer || radar.hotIndices.has(i);
  }

  /* Load a frame invisibly and resolve only after its visible-viewport tiles are
     ready.  Background preloading uses this exact path, so the browser HTTP cache
     is warm even after an offscreen layer is removed. */
  function ensureFrameReady(i, preloading=false){
    const layer = layerFor(i);
    const meta = metaFor(i);
    if(!layer || !meta) return Promise.resolve(null);
    if(map.hasLayer(layer) && meta.ready) return Promise.resolve(layer);
    if(meta.promise) return meta.promise;

    meta.preloading = preloading;
    layer.setOpacity(0);

    meta.promise = new Promise(resolve=>{
      let finished = false;
      let loadedTiles = 0;
      const onTileLoad = ()=>{ loadedTiles++; };
      const cleanup = ()=>{
        layer.off('tileload', onTileLoad);
        layer.off('load', onLoad);
        clearTimeout(fallback);
      };
      const finish = ok=>{
        if(finished) return;
        finished = true;
        cleanup();
        meta.promise = null;
        meta.preloading = false;
        if(ok){ meta.ready = true; meta.warmed = true; }
        if(!shouldKeepFrame(i, layer) && map.hasLayer(layer)){
          map.removeLayer(layer);
          meta.ready = false;
        }
        resolve(ok ? layer : null);
      };
      const onLoad = ()=>finish(true);
      layer.on('tileload', onTileLoad);
      layer.once('load', onLoad);
      const fallback = setTimeout(()=>finish(loadedTiles > 0 || meta.ready), 2400);
      if(!map.hasLayer(layer)) layer.addTo(map);
      else if(meta.ready) queueMicrotask(()=>finish(true));
    });
    return meta.promise;
  }

  function updateFrameUI(i){
    if(!radar.frames.length) return;
    i = Math.max(0, Math.min(i, radar.frames.length-1));
    radar.idx = i;
    radar.desiredIdx = i;
    $('#radarscrub').value = i;
    const f = radar.frames[i];
    const t = new Date(f.time*1000);
    const isNowcast = f.time*1000 > Date.now();
    $('#radartime').textContent = (isNowcast?'+':'') + t.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }

  function setHotWindow(center){
    const next = new Set();
    for(let d=-radar.hotRadius; d<=radar.hotRadius; d++){
      const i = center + d;
      if(i>=0 && i<radar.frames.length) next.add(i);
    }
    radar.hotIndices = next;

    /* Five frames stay resident (current ±2).  That's enough for immediate
       finger-dragging without keeping dozens of decoded 512 px tiles in memory. */
    for(const [key, layer] of Object.entries(radar.layers)){
      const i = radar.layerIndex[key];
      const meta = radar.layerMeta[key];
      if(map.hasLayer(layer) && !next.has(i) && layer!==radar.activeLayer && layer!==radar.pendingLayer && !meta?.preloading){
        map.removeLayer(layer);
        if(meta) meta.ready = false;
      }
    }

    for(const i of next){
      if(i===radar.displayedIdx) continue;
      ensureFrameReady(i, true);
    }
  }

  function stopTimelinePreload(){
    radar.preloadGen++;
    radar.preloadQueue = [];
    radar.bgStarted = false;
  }

  function startTimelinePreload(center){
    if(!radar.frames.length) return;
    const gen = ++radar.preloadGen;
    radar.bgStarted = true;

    /* Nearest timestamps first, then fan out through the whole six-hour strip.
       Four concurrent layers fills the cache quickly without flooding RainViewer
       / IEM or making the browser decode fifty radar frames at the same instant. */
    const order = radar.frames.map((_,i)=>i).sort((a,b)=>{
      const da = Math.abs(a-center), db = Math.abs(b-center);
      return da===db ? a-b : da-db;
    });
    radar.preloadQueue = order.filter(i=>i!==radar.displayedIdx && !radar.hotIndices.has(i));
    let active = 0;

    const pump = ()=>{
      if(gen!==radar.preloadGen || radar.scrubbing) return;
      while(active < radar.preloadConcurrency && radar.preloadQueue.length){
        const i = radar.preloadQueue.shift();
        const meta = metaFor(i);
        if(meta?.warmed && !map.hasLayer(layerFor(i))) continue;
        active++;
        ensureFrameReady(i, true).finally(()=>{
          active--;
          if(gen!==radar.preloadGen) return;
          setTimeout(pump, 0);
        });
      }
    };
    pump();
  }

  function cancelPending(except=null){
    clearTimeout(radar.swapTimer);
    radar.swapTimer = null;
    if(radar.pendingLayer && radar.pendingLayer!==except && radar.pendingLayer!==radar.activeLayer){
      const oldIdx = radar.pendingIdx;
      const oldMeta = oldIdx>=0 ? metaFor(oldIdx) : null;
      if(map.hasLayer(radar.pendingLayer) && !radar.hotIndices.has(oldIdx) && !oldMeta?.preloading){
        map.removeLayer(radar.pendingLayer);
        if(oldMeta) oldMeta.ready = false;
      }
    }
    if(radar.pendingLayer!==except){
      radar.pendingLayer = null;
      radar.pendingIdx = -1;
    }
  }

  function commitFrame(i, incoming, previous, seq){
    if(seq!==radar.swapSeq || radar.desiredIdx!==i || radar.pendingLayer!==incoming) return;
    cancelPending(incoming);
    radar.pendingLayer = null;
    radar.pendingIdx = -1;
    radar.activeLayer = incoming;
    radar.displayedIdx = i;

    setHotWindow(i);

    const instant = radar.scrubbing;
    const container = incoming.getContainer?.();
    if(container) container.style.transition = instant ? 'none' : 'opacity 70ms linear';
    incoming.setOpacity(instant ? 0.75 : 0);
    if(!instant){
      requestAnimationFrame(()=>{
        if(seq===radar.swapSeq && incoming===radar.activeLayer) incoming.setOpacity(0.75);
      });
    }

    if(previous && previous!==incoming){
      const previousIdx = indexForLayer(previous);
      const removePrevious = ()=>{
        previous.setOpacity(0);
        if(!radar.hotIndices.has(previousIdx) && map.hasLayer(previous)){
          map.removeLayer(previous);
          const m = previousIdx>=0 ? metaFor(previousIdx) : null;
          if(m) m.ready = false;
        }
      };
      if(instant) requestAnimationFrame(removePrevious);
      else radar.swapTimer = setTimeout(removePrevious, 85);
    }

    if(container && !instant){
      setTimeout(()=>{ if(container) container.style.transition = ''; }, 100);
    }

    /* Start the one-time full-timeline warm-up only after the first useful frame
       is actually on screen. */
    if(!radar.bgStarted && !radar.scrubbing) startTimelinePreload(i);
  }

  function loadFrame(i){
    if(!radar.frames.length) return;
    i = Math.max(0, Math.min(i, radar.frames.length-1));
    const incoming = layerFor(i);
    const meta = metaFor(i);
    if(!incoming || !meta) return;

    if(incoming===radar.activeLayer){
      radar.displayedIdx = i;
      incoming.setOpacity(0.75);
      setHotWindow(i);
      return;
    }

    const previous = radar.activeLayer;
    const seq = ++radar.swapSeq;
    cancelPending(incoming);
    radar.pendingLayer = incoming;
    radar.pendingIdx = i;

    /* If this timestamp is one of the resident hot frames, swapping is immediate.
       Otherwise keep the old radar visible until the requested frame is complete. */
    if(map.hasLayer(incoming) && meta.ready){
      commitFrame(i, incoming, previous, seq);
      return;
    }

    ensureFrameReady(i, false).then(layer=>{
      if(!layer) return;
      if(seq!==radar.swapSeq || radar.desiredIdx!==i || radar.pendingLayer!==incoming) return;
      commitFrame(i, incoming, previous, seq);
    });
  }

  function queueFrame(i){
    updateFrameUI(i);
    radar.queuedIdx = radar.desiredIdx;
    if(radar.frameRaf) return;
    radar.frameRaf = requestAnimationFrame(()=>{
      radar.frameRaf = null;
      loadFrame(radar.queuedIdx);
    });
  }

  function showFrame(i){
    updateFrameUI(i);
    loadFrame(i);
  }

  function playRadar(){
    if(!radar.frames.length) return;
    radar.playing = true;
    $('#playicon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
    $('#radarplay').setAttribute('aria-label','Pause radar animation');
    const tick = ()=>{
      if(!radar.playing) return;
      showFrame((radar.idx+1) % radar.frames.length);
      radar.timer = setTimeout(tick, 720);
    };
    radar.timer = setTimeout(tick, 300);
  }

  function stopRadar(){
    radar.playing = false;
    clearTimeout(radar.timer);
    radar.timer = null;
    $('#playicon').innerHTML = '<path d="M7 4.5v15l13-7.5z"/>';
    $('#radarplay').setAttribute('aria-label','Play radar animation');
  }

  /* Panning/zooming gets network priority.  Pause animation/background warming,
     then rebuild the five-frame hot window and re-warm the timeline for the new
     viewport once the map settles. */
  map.on('movestart zoomstart', ()=>{
    if(radar.playing) stopRadar();
    stopTimelinePreload();
    for(const i of [...radar.hotIndices]){
      if(i!==radar.displayedIdx) detachFrame(i);
    }
  });
  map.on('moveend zoomend', ()=>{
    clearTimeout(radar.moveTimer);
    radar.moveTimer = setTimeout(()=>{
      for(const meta of Object.values(radar.layerMeta)) meta.warmed = false;
      const center = radar.displayedIdx>=0 ? radar.displayedIdx : radar.desiredIdx;
      if(center>=0){
        setHotWindow(center);
        startTimelinePreload(center);
      }
    }, 120);
  });
}

/* ---------- unit toggle ---------- */
function setUnit(u){
  if(state.radar){ state.radar.destroy(); state.radar = null; }
  state.unit = u; store.set('lemons.unit', u);
  $('#unitF').setAttribute('aria-pressed', u==='F');
  $('#unitC').setAttribute('aria-pressed', u==='C');
  if(state.loc && okSources().length) renderApp();
}
/* ---------- theme: applied before first render, persists forever ---------- */
function themeIcon(dark){
  /* light mode shows a crescent lemon-moon (tap → dark);
     dark mode shows a rayed lemon-sun (tap → light) */
  return dark
    ? `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
        <g stroke="var(--rind)" stroke-width="1.8" stroke-linecap="round">
          <path d="M12 3.2v2M12 18.8v2M3.2 12h2M18.8 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M18.2 5.8l-1.4 1.4M7.2 16.8l-1.4 1.4"/></g>
        <circle cx="12" cy="12" r="4.6" fill="var(--zest)" stroke="var(--ink)" stroke-width="1.6"/></svg>`
    : `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
        <circle cx="12" cy="12" r="7.5" fill="none" stroke="var(--ink)" stroke-width="1.6"/>
        <path d="M12 4.5 A7.5 7.5 0 0 1 12 19.5 A5 7.5 0 0 0 12 4.5 Z" fill="var(--zest)"/></svg>`;
}
function applyTheme(t, save){
  const dark = t === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  const b = $('#themetoggle');
  if(b){ b.innerHTML = themeIcon(dark); b.setAttribute('aria-pressed', dark); }
  let meta = document.querySelector('meta[name="theme-color"]');
  if(!meta){ meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = dark ? '#15150F' : '#FFFDF4';
  if(save) store.set('lemons.theme', dark ? 'dark' : 'light');
}
applyTheme(store.get('lemons.theme') || 'light');
$('#themetoggle').addEventListener('click', ()=>{
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
});

$('#unitF').addEventListener('click', ()=>setUnit('F'));
$('#unitC').addEventListener('click', ()=>setUnit('C'));

/* ---------- intro ---------- */
(function intro(){
  const el = $('#intro');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduced){ el.remove(); return; }
  const timers = [
    setTimeout(()=>el.classList.add('cut'), 700),
    setTimeout(()=>el.classList.add('open'), 1050),
    setTimeout(finish, 1950)
  ];
  el.addEventListener('click', finish, {once:false});
  function finish(){
    timers.forEach(clearTimeout);
    el.classList.add('open','done');
    setTimeout(()=>el.remove(), 300);
  }
})();

/* =====================================================================
   SECRET DOOR #1: the moon screen (click the moon in the sky strip)
   ===================================================================== */
function bigMoonLemon(moon, size){
  /* a proper lemon slice standing in for the moon — seeds as craters,
     shadow side accurately carved by the terminator */
  const shadow = moonShadowPath(120, 120, 104, moon.frac);
  const flip = moon.waxing ? '' : ' transform="scale(-1 1) translate(-240 0)"';
  const seg = a => { const r1=14, r2=88, x=Math.cos(a), y=Math.sin(a);
    return `M ${120+x*r1} ${120+y*r1} L ${120+x*r2} ${120+y*r2}`; };
  const segs = [...Array(8)].map((_,i)=>seg(i*Math.PI/4 + Math.PI/8)).join(' ');
  return `<svg class="bigmoon" viewBox="0 0 240 240" width="${size}" height="${size}" role="img" aria-label="${esc(moon.name)}, ${Math.round(moon.frac*100)}% illuminated">
    <circle cx="120" cy="120" r="104" fill="var(--zest)"/>
    <circle cx="120" cy="120" r="92" fill="var(--pith)"/>
    <circle cx="120" cy="120" r="84" fill="var(--flesh)"/>
    <path d="${segs}" stroke="var(--pith)" stroke-width="6" stroke-linecap="round"/>
    <circle cx="120" cy="120" r="7" fill="var(--pith)"/>
    <ellipse cx="88" cy="82" rx="5" ry="9" fill="var(--rind)" transform="rotate(-28 88 82)"/>
    <ellipse cx="158" cy="140" rx="5" ry="9" fill="var(--rind)" transform="rotate(38 158 140)"/>
    <ellipse cx="104" cy="164" rx="4.5" ry="8" fill="var(--rind)" transform="rotate(-8 104 164)"/>
    ${shadow?`<g${flip}><path d="${shadow}" fill="rgba(35,36,27,.85)"/></g>`:''}
    <circle cx="120" cy="120" r="104" fill="none" stroke="var(--ink)" stroke-width="4"/>
  </svg>`;
}
function moonFactLine(moon){
  const pool = [
    'Same moon everybody else gets, but this one\u2019s yours.',
    'No weather up there. Ever. Forecast accuracy: 100%.',
    'The moon has no idea it looks like a lemon tonight.',
    'It\u2019s been doing this exact routine for 4.5 billion years without a day off.',
    'Technically it\u2019s drifting away 1.5 inches a year. Take it personally.'
  ];
  return pickLine(pool, 13);
}
function openMoonScreen(){
  closeMoonScreen();
  const moon = moonPhase();
  const dFmt = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric'});
  const el = document.createElement('div');
  el.id = 'moonmodal'; el.className = 'moonmodal';
  el.setAttribute('role','dialog'); el.setAttribute('aria-label','Moon');
  el.innerHTML = `
    <button class="modalclose" id="mooncloseX" aria-label="Close">&times;</button>
    <div class="mooncontent" id="mooncontent">
      ${bigMoonLemon(moon, 'min(60vmin, 300px)')}
      <h2 class="moonname">${esc(moon.name)}</h2>
      <div class="statrow moonstats">
        <div class="stat"><div class="k">Illuminated</div><div class="v" id="moonpct">${Math.round(moon.frac*100)}<small>%</small></div></div>
        <div class="stat"><div class="k">Moon age</div><div class="v">${moon.age.toFixed(1)}<small> / ${moon.synodic.toFixed(1)}d</small></div></div>
        <div class="stat"><div class="k">Next full</div><div class="v moondate" id="nextfullsecret">${esc(dFmt.format(moon.nextFull))}</div></div>
        <div class="stat"><div class="k">Next new</div><div class="v moondate" id="nextnewsecret">${esc(dFmt.format(moon.nextNew))}</div></div>
      </div>
      <div class="lemonsays moonsays"><span>Lemons says</span><p>${esc(moonFactLine(moon))}</p></div>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#mooncloseX').addEventListener('click', closeMoonScreen);
  el.addEventListener('click', e=>{ if(e.target === el) closeMoonScreen(); });
  document.addEventListener('keydown', moonEsc);
}
function moonEsc(e){ if(e.key === 'Escape'){ closeMoonScreen(); closeSolitaire(); closeAscent(); closeBmx(); } }
function closeMoonScreen(){
  const el = $('#moonmodal');
  if(el){ msStop(); el.remove(); }
  document.body.style.overflow = '';
  document.removeEventListener('keydown', moonEsc);
}

/* =====================================================================
   SECRET DOOR #2: LEMONSWEEPER (click the percentage inside the moon screen)
   ===================================================================== */
const MS = { w:9, h:9, lemons:10, grid:[], placed:false, over:false, opened:0, flags:0, t0:0, timer:null };
const msTinyLemon = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="var(--zest)" stroke="var(--ink)" stroke-width="2"/><circle cx="12" cy="12" r="5.5" fill="var(--pith)"/><path d="M12 7v10M7 12h10M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--zest)" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const msLeafFlag = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 19C5 10 11 5 19 5c0 8-5 14-14 14Z" fill="var(--leaf)" stroke="var(--ink)" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.5 16.5C10 13 13 10 16.5 7.5" stroke="var(--pith)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
function msStop(){ clearInterval(MS.timer); MS.timer = null; }
function openLemonsweeper(){
  msNew();
}
function msNew(){
  msStop();
  Object.assign(MS, {grid:[], placed:false, over:false, opened:0, flags:0, t0:0});
  for(let i=0;i<MS.w*MS.h;i++) MS.grid.push({lemon:false, adj:0, open:false, flag:false});
  const c = $('#mooncontent'); if(!c) return;
  c.innerHTML = `
    <div class="mshead">
      <button class="linkish" id="msback">&larr; moon</button>
      <span class="mstitle">LEMONSWEEPER<span class="dot">.</span></span>
      <button class="linkish" id="msreset">new squeeze</button>
    </div>
    <div class="msbar">
      <span class="msstat">${msTinyLemon}<b id="mscount">${MS.lemons}</b></span>
      <span class="mssub" id="msmsg">${MS.lemons} lemons hiding. Clear the grove without squeezing one.</span>
      <span class="msstat"><b id="mstime">0</b>s</span>
    </div>
    <div class="msgrid" id="msgrid" style="--cols:${MS.w}">
      ${MS.grid.map((_,i)=>`<button class="mscell" data-i="${i}" aria-label="cell"></button>`).join('')}
    </div>
    <p class="mshint">Tap to squeeze a cell &middot; hold (or right-click) to plant a leaf</p>`;
  $('#msback').addEventListener('click', openMoonScreen);
  $('#msreset').addEventListener('click', msNew);
  const grid = $('#msgrid');
  grid.addEventListener('contextmenu', e=>{ e.preventDefault(); const b=e.target.closest('.mscell'); if(b) msFlag(+b.dataset.i); });
  grid.addEventListener('click', e=>{ const b=e.target.closest('.mscell'); if(b && !b.dataset.held) msOpen(+b.dataset.i); b&&delete b.dataset.held; });
  let holdT=null;
  grid.addEventListener('touchstart', e=>{ const b=e.target.closest('.mscell'); if(!b) return;
    holdT = setTimeout(()=>{ b.dataset.held='1'; msFlag(+b.dataset.i); if(navigator.vibrate) navigator.vibrate(18); }, 420);
  }, {passive:true});
  ['touchend','touchmove','touchcancel'].forEach(ev=>grid.addEventListener(ev, ()=>clearTimeout(holdT), {passive:true}));
}
function msNeighbors(i){
  const x=i%MS.w, y=Math.floor(i/MS.w), out=[];
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy) continue;
    const nx=x+dx, ny=y+dy;
    if(nx>=0&&nx<MS.w&&ny>=0&&ny<MS.h) out.push(ny*MS.w+nx);
  }
  return out;
}
function msPlace(safe){
  const banned = new Set([safe, ...msNeighbors(safe)]);
  let placed=0;
  while(placed<MS.lemons){
    const i = Math.floor(Math.random()*MS.grid.length);
    if(banned.has(i) || MS.grid[i].lemon) continue;
    MS.grid[i].lemon = true; placed++;
  }
  MS.grid.forEach((c,i)=>{ c.adj = msNeighbors(i).filter(n=>MS.grid[n].lemon).length; });
  MS.placed = true; MS.t0 = Date.now();
  MS.timer = setInterval(()=>{ const t=$('#mstime'); if(t) t.textContent = Math.floor((Date.now()-MS.t0)/1000); }, 1000);
}
function msOpen(i){
  if(MS.over) return;
  const c = MS.grid[i];
  if(c.open || c.flag) return;
  if(!MS.placed) msPlace(i);
  if(c.lemon){ msLose(i); return; }
  const stack=[i];
  while(stack.length){
    const j = stack.pop(), g = MS.grid[j];
    if(g.open || g.flag) continue;
    g.open = true; MS.opened++;
    msPaint(j);
    if(g.adj===0) msNeighbors(j).forEach(n=>{ if(!MS.grid[n].open) stack.push(n); });
  }
  if(MS.opened === MS.w*MS.h - MS.lemons) msWin();
}
function msFlag(i){
  if(MS.over) return;
  const c = MS.grid[i];
  if(c.open) return;
  c.flag = !c.flag;
  MS.flags += c.flag ? 1 : -1;
  msPaint(i);
  const n = $('#mscount'); if(n) n.textContent = Math.max(MS.lemons - MS.flags, 0);
}
function msPaint(i){
  const b = document.querySelector(`.mscell[data-i="${i}"]`); if(!b) return;
  const c = MS.grid[i];
  b.classList.toggle('open', c.open);
  if(c.flag){ b.innerHTML = msLeafFlag; return; }
  if(!c.open){ b.innerHTML=''; return; }
  b.innerHTML = c.adj ? `<span class="n n${Math.min(c.adj,5)}">${c.adj}</span>` : '';
}
function msLose(hit){
  MS.over = true; msStop();
  MS.grid.forEach((c,i)=>{ if(c.lemon){ const b=document.querySelector(`.mscell[data-i="${i}"]`); if(b){ b.classList.add('open'); b.innerHTML = msTinyLemon; } } });
  const hb = document.querySelector(`.mscell[data-i="${hit}"]`); if(hb) hb.classList.add('boom');
  const m = $('#msmsg'); if(m) m.textContent = 'You found a lemon the hard way.';
}
function msWin(){
  MS.over = true; msStop();
  const secs = Math.floor((Date.now()-MS.t0)/1000);
  MS.grid.forEach((c,i)=>{ if(c.lemon && !c.flag){ const b=document.querySelector(`.mscell[data-i="${i}"]`); if(b) b.innerHTML = msLeafFlag; } });
  const m = $('#msmsg'); if(m) m.textContent = `Grove cleared in ${secs}s. Not a single lemon squeezed.`;
}

/* =====================================================================
   SECRET DOOR #3: LEMONRISE. (click sunrise or sunset in the sky strip)
   ===================================================================== */
function fmtDur(ms){
  const m = Math.round(ms/60000);
  return `${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}m`;
}
function fmtDelta(ms){
  const s = Math.round(Math.abs(ms)/1000), sign = ms>=0?'+':'\u2212';
  const mm = Math.floor(s/60), ss = s%60;
  return `${sign}${mm?mm+'m ':''}${ss}s`;
}
function sunArcSVG(riseMs, setMs){
  const P0=[34,142], P1=[160,16], P2=[286,142];
  const t = Math.max(-0.08, Math.min(1.08, (Date.now()-riseMs)/(setMs-riseMs)));
  const up = t>=0 && t<=1;
  const tt = Math.max(0, Math.min(1, t));
  const bx = (1-tt)*(1-tt)*P0[0] + 2*(1-tt)*tt*P1[0] + tt*tt*P2[0];
  const by = up ? (1-tt)*(1-tt)*P0[1] + 2*(1-tt)*tt*P1[1] + tt*tt*P2[1] : 160;
  const rays = up ? [...Array(8)].map((_,i)=>{
    const a = i*Math.PI/4 + Math.PI/8, r1=17, r2=22;
    return `M ${(bx+Math.cos(a)*r1).toFixed(1)} ${(by+Math.sin(a)*r1).toFixed(1)} L ${(bx+Math.cos(a)*r2).toFixed(1)} ${(by+Math.sin(a)*r2).toFixed(1)}`;
  }).join(' ') : '';
  return `<svg class="sunarc" viewBox="0 0 320 178" role="img" aria-label="Sun position">
    <path d="M ${P0[0]} ${P0[1]} Q ${P1[0]} ${P1[1]} ${P2[0]} ${P2[1]}" fill="none" stroke="var(--hairline)" stroke-width="1.6" stroke-dasharray="1 6" stroke-linecap="round"/>
    <path d="M14 142 H306" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>
    <g opacity="${up?1:.35}">
      ${rays?`<path d="${rays}" stroke="var(--rind)" stroke-width="2" stroke-linecap="round"/>`:''}
      <circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="13" fill="var(--zest)" stroke="var(--ink)" stroke-width="2.4"/>
      <circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="8.5" fill="var(--pith)"/>
      <path d="M ${bx.toFixed(1)} ${(by-7).toFixed(1)} v14 M ${(bx-7).toFixed(1)} ${by.toFixed(1)} h14 M ${(bx-5).toFixed(1)} ${(by-5).toFixed(1)} l10 10 M ${(bx+5).toFixed(1)} ${(by-5).toFixed(1)} l-10 10" stroke="var(--zest)" stroke-width="1.8" stroke-linecap="round"/>
    </g>
    <path d="M ${P0[0]} 136 v12 M ${P2[0]} 136 v12" stroke="var(--ink)" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
}
function sunFactLine(){
  return pickLine([
    'The sun has not missed a single morning in 4.5 billion years. Insane streak.',
    'Day length is decided by orbital mechanics, not by how early you get up.',
    'Technically the sun neither rises nor sets. Legally, we let it slide.',
    'Every sunset is the sun going to bother somebody else for a while.'
  ], 21);
}
function openSunScreen(){
  closeMoonScreen();
  const api = state.sun;
  const calcToday = solarTimes(state.loc.lat, state.loc.lon, 0);
  const calcTomorrow = solarTimes(state.loc.lat, state.loc.lon, 1);
  const rise = api?.sunrise ? new Date(api.sunrise) : calcToday?.sunrise;
  const set  = api?.sunset  ? new Date(api.sunset)  : calcToday?.sunset;
  if(!rise || !set) return;
  const dayLen = set - rise;
  /* compare today/tomorrow with the same method so any bias cancels out */
  const delta = (calcToday && calcTomorrow) ? ((calcTomorrow.sunset-calcTomorrow.sunrise) - (calcToday.sunset-calcToday.sunrise)) : null;
  const noon = new Date((rise.getTime()+set.getTime())/2);
  const el = document.createElement('div');
  el.id = 'moonmodal'; el.className = 'moonmodal';
  el.setAttribute('role','dialog'); el.setAttribute('aria-label','Lemonrise and lemonset');
  el.innerHTML = `
    <button class="modalclose" id="mooncloseX" aria-label="Close">&times;</button>
    <div class="mooncontent">
      ${sunArcSVG(rise.getTime(), set.getTime())}
      <h2 class="moonname">${esc(fmtDur(dayLen))} of daylight</h2>
      <div class="statrow moonstats">
        <div class="stat"><div class="k">Lemonrise</div><div class="v moondate">${esc(skyTime(rise))}</div></div>
        <div class="stat"><div class="k">Lemonset</div><div class="v moondate" id="sunsetsecret">${esc(skyTime(set))}</div></div>
        <div class="stat"><div class="k">Solar noon</div><div class="v moondate">${esc(skyTime(noon))}</div></div>
        <div class="stat"><div class="k">Tomorrow</div><div class="v moondate" id="tomorrowsecret">${delta!=null?esc(fmtDelta(delta)):'\u2014'}</div></div>
      </div>
      <div class="lemonsays moonsays"><span>Lemons says</span><p>${esc(sunFactLine())}</p></div>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#mooncloseX').addEventListener('click', closeMoonScreen);
  el.addEventListener('click', e=>{ if(e.target === el) closeMoonScreen(); });
  document.addEventListener('keydown', moonEsc);
}

/* =====================================================================
   SECRET DOOR #4: LEMONCRAFT. (click the Lemonset time)
   A tiny creative-mode voxel sandbox. Superflat grove, six lemon blocks,
   fly around, build whatever. Desktop + touch.
   ===================================================================== */
const LC = { open:false, three:null, raf:0, blocks:new Map(), sel:0, cap:6000,
  yaw:0, pitch:-0.15, keys:{}, joy:null, look:null, vy:0, saveT:null };
const LC_BLOCKS = [
  {name:'Zest',  color:0xF4CE3E}, {name:'Rind',  color:0xDDB32A},
  {name:'Flesh', color:0xFBF0B2}, {name:'Pith',  color:0xFFFDF4},
  {name:'Leaf',  color:0x4E7A3A}, {name:'Ink',   color:0x23241B}
];
function loadThree(){
  if(window.THREE) return Promise.resolve();
  if(LC.threeP) return LC.threeP;
  LC.threeP = new Promise((res, rej)=>{
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
    s.onload = res; s.onerror = ()=>rej(new Error('three failed'));
    document.head.appendChild(s);
  });
  return LC.threeP;
}
function openLemoncraft(){
  if(LC.open) return;
  closeMoonScreen();
  LC.open = true;
  const touch = 'ontouchstart' in window;
  const el = document.createElement('div');
  el.id = 'lcmodal';
  el.innerHTML = `
    <div class="lcload">${lemonSpinner()}<h2>Planting the grove\u2026</h2></div>
    <div class="lctop">
      <span class="mstitle">LEMONCRAFT<span class="dot">.</span></span>
      <span class="lccount" id="lccount"></span>
      <span style="flex:1"></span>
      <button class="linkish" id="lcreset">clear grove</button>
      <button class="modalclose lcclose" id="lcclose" aria-label="Close">&times;</button>
    </div>
    <div class="lccross" id="lccross"></div>
    <div class="lchotbar" id="lchotbar">
      ${LC_BLOCKS.map((b,i)=>`<button class="lcswatch${i===0?' sel':''}" data-b="${i}" style="--c:#${b.color.toString(16).padStart(6,'0')}" aria-label="${esc(b.name)}"><i></i></button>`).join('')}
    </div>
    <p class="lchint">${touch
      ? 'left thumb to move \u00b7 drag to look \u00b7 tap to place \u00b7 hold to break \u00b7 buttons to fly'
      : 'click to lock in \u00b7 WASD + Space/Shift to fly \u00b7 right-click place \u00b7 left-click break \u00b7 1\u20136 blocks'}</p>
    ${touch?`<div class="lcfly"><button id="lcup" aria-label="Fly up">&#9650;</button><button id="lcdown" aria-label="Fly down">&#9660;</button></div>
    <div class="lcjoy" id="lcjoy"><i id="lcjoynub"></i></div>`:''}`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#lcclose').addEventListener('click', closeLemoncraft);
  loadThree().then(()=>lcStart(el, touch)).catch(()=>{
    el.querySelector('.lcload h2').textContent = 'The grove failed to load \u2014 check the connection.';
  });
}
function lcMakeGrassTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#A9BF7D'; ctx.fillRect(0,0,256,256);
  /* two-tone blade strokes, seeded so it tiles without visible repetition at this scale */
  let seed = 42;
  const rnd = () => { seed = (seed*1664525+1013904223)>>>0; return seed/4294967296; };
  const blade = (x,y,h,tone)=>{
    ctx.strokeStyle = tone; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
    const lean = (rnd()-0.5)*10;
    ctx.beginPath(); ctx.moveTo(x,y);
    ctx.quadraticCurveTo(x+lean*0.5, y-h*0.6, x+lean, y-h);
    ctx.stroke();
  };
  for(let i=0;i<420;i++){
    const x = rnd()*256, y = rnd()*256, h = 8+rnd()*13;
    blade(x,y,h, i%3===0 ? '#8FA968' : (i%3===1 ? '#B7CC8E' : '#9FB575'));
  }
  return new window.THREE.CanvasTexture(c);
}
function lcMakeSunCanvas(){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d'), cx=64, cy=64;
  ctx.strokeStyle = '#DDB32A'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  for(let i=0;i<8;i++){
    const a = i*Math.PI/4 + Math.PI/8;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(a)*39, cy+Math.sin(a)*39);
    ctx.lineTo(cx+Math.cos(a)*53, cy+Math.sin(a)*53);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx,cy,33,0,Math.PI*2); ctx.fillStyle='#F4CE3E'; ctx.fill();
  ctx.lineWidth=5; ctx.strokeStyle='#23241B'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx,cy,23,0,Math.PI*2); ctx.fillStyle='#FFFDF4'; ctx.fill();
  ctx.strokeStyle='#F4CE3E'; ctx.lineWidth=5; ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(cx,cy-19); ctx.lineTo(cx,cy+19);
  ctx.moveTo(cx-19,cy); ctx.lineTo(cx+19,cy);
  ctx.moveTo(cx-13,cy-13); ctx.lineTo(cx+13,cy+13);
  ctx.moveTo(cx+13,cy-13); ctx.lineTo(cx-13,cy+13);
  ctx.stroke();
  return c;
}
function lcMakeMoonCanvas(frac, waxing){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d'), cx=64, cy=64, r=33;
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fillStyle='#F4CE3E'; ctx.fill();
  ctx.fillStyle = '#DDB32A';
  const seed = (x,y,rx,ry,rot)=>{ ctx.save(); ctx.translate(x,y); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2); ctx.fill(); ctx.restore(); };
  seed(cx-15,cy-9,4,7,-0.5); seed(cx+13,cy+11,4,7,0.6); seed(cx-3,cy+15,3.5,6,-0.15);
  if(frac < 0.99){
    const d = moonShadowPath(cx, cy, r, frac);
    if(d){
      ctx.save();
      if(!waxing){ ctx.translate(cx*2, 0); ctx.scale(-1,1); }
      ctx.fillStyle = 'rgba(35,36,27,.85)';
      ctx.fill(new Path2D(d));
      ctx.restore();
    }
  }
  ctx.lineWidth=5; ctx.strokeStyle='#23241B';
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
  return c;
}
function lcKey(x,y,z){ return x+'|'+y+'|'+z; }
function lcStart(el, touch){
  const T = window.THREE;
  const load = el.querySelector('.lcload'); if(load) load.remove();
  const renderer = new T.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.id = 'lccanvas';
  el.prepend(renderer.domElement);

  const scene = new T.Scene();
  scene.background = new T.Color(0xFFFDF4);
  scene.fog = new T.Fog(0xFFFDF4, 34, 110);

  scene.add(new T.HemisphereLight(0xFFFDF4, 0xC9C39A, 0.95));
  const dir = new T.DirectionalLight(0xFFF3BE, 0.55);
  dir.position.set(1.2, 1.8, 0.8); scene.add(dir);

  /* lemongrass ground — a tileable hand-drawn texture instead of a technical grid,
     so the grove floor actually looks like grass rather than graph paper */
  const grassTex = lcMakeGrassTexture();
  grassTex.wrapS = grassTex.wrapT = T.RepeatWrapping;
  grassTex.repeat.set(26, 26);
  grassTex.anisotropy = 4;
  const ground = new T.Mesh(new T.PlaneGeometry(100,100), new T.MeshLambertMaterial({map:grassTex}));
  ground.rotation.x = -Math.PI/2; scene.add(ground);

  /* the sky: a lemon-sun and a lemon-moon, positioned along an arc using this
     location's actual sunrise/sunset — not decorative placeholders */
  const skyRise = (state.sun?.sunrise ? new Date(state.sun.sunrise) : solarTimes(state.loc.lat, state.loc.lon)?.sunrise) || new Date(Date.now()-6*3600000);
  const skySet  = (state.sun?.sunset  ? new Date(state.sun.sunset)  : solarTimes(state.loc.lat, state.loc.lon)?.sunset)  || new Date(Date.now()+6*3600000);
  const moon = moonPhase();
  const sunMat = new T.SpriteMaterial({map:new T.CanvasTexture(lcMakeSunCanvas()), transparent:true});
  const moonMat = new T.SpriteMaterial({map:new T.CanvasTexture(lcMakeMoonCanvas(moon.frac, moon.waxing)), transparent:true});
  const sunSprite = new T.Sprite(sunMat); sunSprite.scale.set(24,24,1); scene.add(sunSprite);
  const moonSprite = new T.Sprite(moonMat); moonSprite.scale.set(7,7,1); scene.add(moonSprite);
  const SKY_R = 74, SKY_Y0 = 6;
  function placeSky(sprite, angle){
    sprite.position.set(Math.cos(angle)*SKY_R, SKY_Y0 + Math.sin(angle)*SKY_R, -Math.sin(angle*0.4)*20 - 30);
  }
  function updateSky(){
    const now = Date.now(), dayLen = skySet - skyRise;
    const sunPhase = (now - skyRise.getTime()) / dayLen;
    const sunAngle = Math.PI * (1 - sunPhase);
    placeSky(sunSprite, sunAngle);
    placeSky(moonSprite, sunAngle + Math.PI);
  }
  updateSky();

  const camera = new T.PerspectiveCamera(72, window.innerWidth/window.innerHeight, 0.1, 240);
  const pos = new T.Vector3(0, 3.4, 9);
  LC.yaw = 0; LC.pitch = -0.12;

  const geo = new T.BoxGeometry(1,1,1);
  const edgeGeo = new T.EdgesGeometry(geo);
  const mats = LC_BLOCKS.map(b=>new T.MeshLambertMaterial({color:b.color}));
  const edgeDark = new T.LineBasicMaterial({color:0x23241B, transparent:true, opacity:0.32});
  const edgeLight = new T.LineBasicMaterial({color:0xFFFDF4, transparent:true, opacity:0.35});
  const blockGroup = new T.Group(); scene.add(blockGroup);

  function addBlock(x,y,z,type,skipSave){
    const k = lcKey(x,y,z);
    if(LC.blocks.has(k) || LC.blocks.size>=LC.cap) return;
    if(Math.abs(x)>48 || Math.abs(z)>48 || y<0 || y>30) return;
    const m = new T.Mesh(geo, mats[type]);
    m.position.set(x+0.5, y+0.5, z+0.5);
    m.userData = {x,y,z,type};
    m.add(new T.LineSegments(edgeGeo, type===5?edgeLight:edgeDark));
    blockGroup.add(m);
    LC.blocks.set(k, m);
    lcCount(); if(!skipSave) lcSave();
  }
  function removeBlock(m){
    const {x,y,z} = m.userData;
    blockGroup.remove(m);
    LC.blocks.delete(lcKey(x,y,z));
    lcCount(); lcSave();
  }
  function lcCount(){ const c=$('#lccount'); if(c) c.textContent = LC.blocks.size ? LC.blocks.size+' blocks' : ''; }
  function lcSave(){
    clearTimeout(LC.saveT);
    LC.saveT = setTimeout(()=>{
      store.set('lemons.craft', [...LC.blocks.values()].map(m=>[m.userData.x,m.userData.y,m.userData.z,m.userData.type]));
    }, 700);
  }
  (store.get('lemons.craft')||[]).forEach(([x,y,z,t])=>{ if(typeof t==='number' && mats[t]) addBlock(x,y,z,t,true); });
  lcCount();

  /* a little welcome tree if the grove is empty */
  if(!LC.blocks.size && !store.get('lemons.craft')){
    [[0,0],[0,1],[0,2]].forEach(([,y])=>addBlock(0,y,0,1,true));
    [[-1,3,0],[1,3,0],[0,3,-1],[0,3,1],[0,3,0],[0,4,0]].forEach(([x,y,z])=>addBlock(x,y,z,4,true));
    addBlock(1,4,0,0,true); addBlock(-1,4,-1,0,true);
  }

  const ray = new T.Raycaster(); ray.far = 11;
  function castFrom(nx, ny){
    ray.setFromCamera({x:nx, y:ny}, camera);
    const hitB = ray.intersectObjects(blockGroup.children, false)[0];
    const hitG = ray.intersectObject(ground, false)[0];
    if(hitB && (!hitG || hitB.distance <= hitG.distance)) return {type:'block', hit:hitB};
    if(hitG) return {type:'ground', hit:hitG};
    return null;
  }
  function doPlace(nx, ny){
    const r = castFrom(nx, ny); if(!r) return;
    if(r.type==='ground'){
      addBlock(Math.floor(r.hit.point.x), 0, Math.floor(r.hit.point.z), LC.sel);
    }else{
      const m = r.hit.object, n = r.hit.face.normal;
      addBlock(Math.round(m.position.x-0.5+n.x), Math.round(m.position.y-0.5+n.y), Math.round(m.position.z-0.5+n.z), LC.sel);
    }
  }
  function doBreak(nx, ny){
    const r = castFrom(nx, ny);
    if(r && r.type==='block') removeBlock(r.hit.object);
  }

  /* hotbar */
  $('#lchotbar').addEventListener('click', e=>{
    const b = e.target.closest('.lcswatch'); if(!b) return;
    LC.sel = +b.dataset.b;
    document.querySelectorAll('.lcswatch').forEach(s=>s.classList.toggle('sel', s===b));
  });
  $('#lcreset').addEventListener('click', ()=>{
    if(!confirm('Clear the whole grove?')) return;
    [...LC.blocks.values()].forEach(m=>blockGroup.remove(m));
    LC.blocks.clear(); lcCount(); store.set('lemons.craft', []);
  });

  /* ---------- desktop controls ---------- */
  const cv = renderer.domElement;
  LC.onKeyDown = e=>{
    if(e.code==='Escape' && !document.pointerLockElement){ closeLemoncraft(); return; }
    if(e.code.startsWith('Digit')){ const i=+e.code.slice(5)-1; if(LC_BLOCKS[i]){ LC.sel=i;
      document.querySelectorAll('.lcswatch').forEach((s,j)=>s.classList.toggle('sel', j===i)); } }
    LC.keys[e.code] = true;
    if(['Space','ShiftLeft','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
  };
  LC.onKeyUp = e=>{ LC.keys[e.code] = false; };
  if(!touch){
    window.addEventListener('keydown', LC.onKeyDown);
    window.addEventListener('keyup', LC.onKeyUp);
    cv.addEventListener('click', ()=>{ if(document.pointerLockElement!==cv) cv.requestPointerLock(); });
    cv.addEventListener('mousedown', e=>{
      if(document.pointerLockElement!==cv) return;
      if(e.button===0) doBreak(0,0);
      if(e.button===2) doPlace(0,0);
    });
    document.addEventListener('mousemove', LC.onMouseMove = e=>{
      if(document.pointerLockElement!==cv) return;
      LC.yaw -= e.movementX*0.0024;
      LC.pitch = Math.max(-1.45, Math.min(1.45, LC.pitch - e.movementY*0.0024));
    });
    cv.addEventListener('contextmenu', e=>e.preventDefault());
  }

  /* ---------- touch controls ---------- */
  if(touch){
    const joyEl = $('#lcjoy'), nub = $('#lcjoynub');
    let holdT = null;
    el.addEventListener('touchstart', e=>{
      for(const t of e.changedTouches){
        if(t.target.closest('.lctop,.lchotbar,.lcfly')) continue;
        if(t.clientX < window.innerWidth*0.42 && t.clientY > window.innerHeight*0.5 && !LC.joy){
          LC.joy = {id:t.identifier, x0:t.clientX, y0:t.clientY, dx:0, dy:0};
          joyEl.style.left = (t.clientX-52)+'px'; joyEl.style.top = (t.clientY-52)+'px';
          joyEl.classList.add('on');
        }else if(!LC.look){
          LC.look = {id:t.identifier, x:t.clientX, y:t.clientY, x0:t.clientX, y0:t.clientY, t0:Date.now(), moved:0};
          holdT = setTimeout(()=>{
            if(LC.look && LC.look.moved<10){
              const nx = (LC.look.x0/window.innerWidth)*2-1, ny = -(LC.look.y0/window.innerHeight)*2+1;
              doBreak(nx, ny); if(navigator.vibrate) navigator.vibrate(16);
              LC.look.consumed = true;
            }
          }, 430);
        }
      }
    }, {passive:true});
    el.addEventListener('touchmove', e=>{
      for(const t of e.changedTouches){
        if(LC.joy && t.identifier===LC.joy.id){
          LC.joy.dx = Math.max(-46, Math.min(46, t.clientX-LC.joy.x0));
          LC.joy.dy = Math.max(-46, Math.min(46, t.clientY-LC.joy.y0));
          nub.style.transform = `translate(${LC.joy.dx}px,${LC.joy.dy}px)`;
        }else if(LC.look && t.identifier===LC.look.id){
          const dx = t.clientX-LC.look.x, dy = t.clientY-LC.look.y;
          LC.look.moved += Math.abs(dx)+Math.abs(dy);
          LC.look.x = t.clientX; LC.look.y = t.clientY;
          LC.yaw -= dx*0.005;
          LC.pitch = Math.max(-1.45, Math.min(1.45, LC.pitch - dy*0.005));
        }
      }
    }, {passive:true});
    el.addEventListener('touchend', e=>{
      for(const t of e.changedTouches){
        if(LC.joy && t.identifier===LC.joy.id){
          LC.joy = null; joyEl.classList.remove('on'); nub.style.transform = '';
        }else if(LC.look && t.identifier===LC.look.id){
          clearTimeout(holdT);
          if(!LC.look.consumed && LC.look.moved<10 && Date.now()-LC.look.t0<260){
            const nx = (t.clientX/window.innerWidth)*2-1, ny = -(t.clientY/window.innerHeight)*2+1;
            doPlace(nx, ny);
          }
          LC.look = null;
        }
      }
    }, {passive:true});
    const hold = (id, dir)=>{ const b=$(id); let iv=null;
      b.addEventListener('touchstart', e=>{ e.preventDefault(); LC.vy=dir; }, {passive:false});
      b.addEventListener('touchend', ()=>{ LC.vy=0; });
    };
    hold('#lcup', 1); hold('#lcdown', -1);
  }

  LC.onResize = ()=>{
    camera.aspect = window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', LC.onResize);

  /* ---------- loop ---------- */
  const clock = new T.Clock();
  LC.renderer = renderer; LC.scene = scene;
  function tick(){
    LC.raf = requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05), sp = 7.5*dt;
    LC.skyClock = (LC.skyClock||0) + dt;
    if(LC.skyClock > 5){ LC.skyClock = 0; updateSky(); }
    let f = 0, s = 0, v = LC.vy;
    if(!touch){
      f = (LC.keys.KeyW||LC.keys.ArrowUp?1:0) - (LC.keys.KeyS||LC.keys.ArrowDown?1:0);
      s = (LC.keys.KeyD?1:0) - (LC.keys.KeyA?1:0);
      v = (LC.keys.Space?1:0) - (LC.keys.ShiftLeft?1:0);
    }else if(LC.joy){
      f = -LC.joy.dy/46; s = LC.joy.dx/46;
    }
    pos.x += (Math.sin(LC.yaw)*-f + Math.cos(LC.yaw)*s) * sp;
    pos.z += (Math.cos(LC.yaw)*-f - Math.sin(LC.yaw)*s) * sp;
    pos.y = Math.max(0.6, Math.min(34, pos.y + v*sp));
    pos.x = Math.max(-49, Math.min(49, pos.x));
    pos.z = Math.max(-49, Math.min(49, pos.z));
    camera.position.copy(pos);
    camera.rotation.set(0,0,0);
    camera.rotateY(LC.yaw); camera.rotateX(LC.pitch);
    renderer.render(scene, camera);
  }
  tick();
}
function closeLemoncraft(){
  if(!LC.open) return;
  LC.open = false;
  cancelAnimationFrame(LC.raf);
  clearTimeout(LC.saveT);
  if(LC.blocks.size || store.get('lemons.craft')) {
    store.set('lemons.craft', [...LC.blocks.values()].map(m=>[m.userData.x,m.userData.y,m.userData.z,m.userData.type]));
  }
  window.removeEventListener('keydown', LC.onKeyDown);
  window.removeEventListener('keyup', LC.onKeyUp);
  window.removeEventListener('resize', LC.onResize);
  if(LC.onMouseMove) document.removeEventListener('mousemove', LC.onMouseMove);
  if(document.pointerLockElement) document.exitPointerLock();
  if(LC.renderer){ LC.renderer.dispose(); LC.renderer = null; }
  LC.blocks.clear(); LC.keys = {}; LC.joy = null; LC.look = null; LC.vy = 0;
  const el = $('#lcmodal'); if(el) el.remove();
  document.body.style.overflow = '';
}

/* =====================================================================
   SECRET DOOR #5: LEMON SOLITAIRE (click "Tomorrow" in the Lemonrise screen)
   Standard Klondike rules, reskinned as four lemon-orchard suits.
   Two "warm" suits (Zest, Rind) and two "cool" suits (Leaf, Seed) stand in
   for red/black so classic alternating-color tableau rules still apply.
   ===================================================================== */
const SOL_SUITS = [
  {id:'zest', warm:true,  glyph:'\u25CF', name:'Zest'},   // filled dot
  {id:'rind', warm:true,  glyph:'\u25C6', name:'Rind'},   // diamond
  {id:'leaf', warm:false, glyph:'\u2663', name:'Leaf'},   // clover-ish
  {id:'seed', warm:false, glyph:'\u2660', name:'Seed'}    // seed/spade-ish
];
const SOL_RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const SOL = { tab:[], stock:[], waste:[], found:{zest:[],rind:[],leaf:[],seed:[]}, sel:null, open:false, moves:0, t0:0, timer:null };

function solNewDeck(){
  const deck = [];
  SOL_SUITS.forEach(s => SOL_RANKS.forEach((r,i)=> deck.push({suit:s.id, rank:r, val:i+1, warm:s.warm, up:false})));
  for(let i=deck.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [deck[i],deck[j]] = [deck[j],deck[i]]; }
  return deck;
}
function solDeal(){
  const deck = solNewDeck();
  const tab = [[],[],[],[],[],[],[]];
  for(let col=0; col<7; col++){
    for(let row=0; row<=col; row++){
      const c = deck.pop();
      c.up = (row===col);
      tab[col].push(c);
    }
  }
  Object.assign(SOL, { tab, stock:deck, waste:[], found:{zest:[],rind:[],leaf:[],seed:[]}, sel:null, moves:0, t0:Date.now() });
}
function solColor(c){ return c.warm; } // true = warm family, false = cool family
function solCanStackTableau(card, onto){
  if(!onto) return card.val === 13; // empty column only takes a King
  return onto.up && onto.val === card.val+1 && onto.warm !== card.warm;
}
function solCanStackFoundation(card, pileArr, suitId){
  if(card.suit !== suitId) return false;
  const top = pileArr[pileArr.length-1];
  return top ? card.val === top.val+1 : card.val === 1;
}
function solWon(){ return SOL_SUITS.every(s => SOL.found[s.id].length === 13); }
function solAutoFoundationTarget(card){
  const s = SOL_SUITS.find(s=>s.id===card.suit);
  return solCanStackFoundation(card, SOL.found[s.id], s.id) ? s.id : null;
}

function solSuitIcon(id, size){
  const S = `viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"`;
  if(id==='zest') return `<svg ${S}><circle cx="12" cy="12" r="9" fill="currentColor"/><circle cx="12" cy="12" r="5.6" fill="var(--pith)"/><path d="M12 7.2v9.6M7.2 12h9.6M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  if(id==='rind') return `<svg ${S}><path d="M3.4 12c0-.9.6-1.7 1.5-2C6.2 7.6 8.8 6 12 6s5.8 1.6 7.1 4c.9.3 1.5 1.1 1.5 2s-.6 1.7-1.5 2c-1.3 2.4-3.9 4-7.1 4s-5.8-1.6-7.1-4c-.9-.3-1.5-1.1-1.5-2Z" fill="currentColor"/><path d="M13.4 6.3c-.3-1.7 1-2.8 2.8-2.6.1 1.6-1.1 2.7-2.8 2.6Z" fill="currentColor"/></svg>`;
  if(id==='leaf') return `<svg ${S}><path d="M4.5 19.5C4.5 10.5 10.5 4.5 19.5 4.5c0 9-6 15-15 15Z" fill="currentColor"/><path d="M7 17c3-3.6 6.4-7 10-10" stroke="var(--pith)" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`;
  return `<svg ${S}><path d="M12 3.5c3.6 3.4 5.5 6.6 5.5 9.9a5.5 5.5 0 0 1-11 0c0-3.3 1.9-6.5 5.5-9.9Z" fill="currentColor"/><path d="M12 8v8" stroke="var(--pith)" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}
function solCardFace(c){
  const tone = c.warm ? 'warm' : 'cool';
  return `<div class="solcard ${tone}">
    <span class="solcorner"><b>${c.rank}</b>${solSuitIcon(c.suit, 10)}</span>
    <span class="solbig">${solSuitIcon(c.suit, 24)}</span>
  </div>`;
}
function solCardBack(){
  return `<div class="solcard solback">
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="var(--zest)" stroke="var(--ink)" stroke-width="1.4"/>
      <circle cx="12" cy="12" r="5.8" fill="var(--pith)"/>
      <path d="M12 7v10M7 12h10M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="var(--zest)" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </div>`;
}
/* ---- undo: cheap full-state snapshots ---- */
function solSnapshot(){
  SOL.undo = SOL.undo || [];
  SOL.undo.push(JSON.stringify({tab:SOL.tab, stock:SOL.stock, waste:SOL.waste, found:SOL.found, moves:SOL.moves}));
  if(SOL.undo.length > 60) SOL.undo.shift();
}
function solUndo(){
  if(!SOL.undo || !SOL.undo.length) { solMsg('Nothing to unsqueeze.'); return; }
  const snap = JSON.parse(SOL.undo.pop());
  Object.assign(SOL, {tab:snap.tab, stock:snap.stock, waste:snap.waste, found:snap.found, moves:snap.moves, sel:null});
  solRender(); solMsg('Rewound one move.');
}

function openSolitaire(){
  closeMoonScreen();
  SOL.open = true;
  solDeal();
  const el = document.createElement('div');
  el.id = 'solmodal'; el.className = 'gamemodal';
  el.setAttribute('role','dialog'); el.setAttribute('aria-label','Lemon Solitaire');
  el.innerHTML = `
    <button class="modalclose" id="solcloseX" aria-label="Close">&times;</button>
    <div class="solwrap">
      <div class="mshead">
        <span class="mstitle">LEMON SOLITAIRE<span class="dot">.</span></span>
        <span style="flex:1"></span>
        <button class="linkish" id="solundo">undo</button>
        <button class="linkish" id="solnew">new deal</button>
      </div>
      <div class="msbar">
        <span class="msstat"><b id="solmoves">0</b> moves</span>
        <span class="mssub" id="solmsgtop"></span>
        <span class="msstat"><b id="soltime">0:00</b></span>
      </div>
      <div class="soltop">
        <div class="solpile" id="solstock"></div>
        <div class="solpile" id="solwaste"></div>
        <div style="flex:1"></div>
        <div class="solfound" id="solfound"></div>
      </div>
      <div class="soltableau" id="soltableau"></div>
      <p class="mshint" id="solmsg">Tap a card to lift it, tap where it lands. Tap the stock to draw.</p>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#solcloseX').addEventListener('click', closeSolitaire);
  $('#solnew').addEventListener('click', ()=>{ SOL.undo = []; solDeal(); solStartTimer(); solRender(); });
  $('#solundo').addEventListener('click', solUndo);
  solStartTimer();
  el.addEventListener('click', e=>{ if(e.target === el) closeSolitaire(); });
  document.addEventListener('keydown', moonEsc);
  $('#solstock').addEventListener('click', solDrawStock);
  solRender();
}
function solStartTimer(){
  clearInterval(SOL.tInt);
  SOL.tInt = setInterval(()=>{
    const el = $('#soltime'); if(!el) return;
    const sec = Math.floor((Date.now()-SOL.t0)/1000);
    el.textContent = Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0');
  }, 1000);
}
function closeSolitaire(){
  if(!SOL.open) return;
  SOL.open = false;
  clearInterval(SOL.tInt);
  const el = $('#solmodal'); if(el) el.remove();
  document.body.style.overflow = '';
}
function solDrawStock(){
  if(!SOL.stock.length && !SOL.waste.length) return;
  solSnapshot();
  if(!SOL.stock.length){
    SOL.stock = SOL.waste.reverse().map(c=>({...c, up:false}));
    SOL.waste = [];
  }else{
    const c = SOL.stock.pop(); c.up = true; SOL.waste.push(c);
  }
  SOL.sel = null;
  solRender();
}
function solSelect(src){
  if(SOL.sel && SOL.sel.src.col===src.col && SOL.sel.src.pile===src.pile){ SOL.sel = null; solRender(); return; }
  SOL.sel = {src};
  solRender();
}
function solMsg(t){ const m = $('#solmsg'); if(m) m.textContent = t; }
function solTryMoveTo(destCol){
  if(!SOL.sel) return;
  const {src} = SOL.sel;
  let cards;
  if(src.pile === 'waste') cards = [SOL.waste[SOL.waste.length-1]];
  else if(src.pile === 'found') cards = [SOL.found[src.suit][SOL.found[src.suit].length-1]];
  else cards = SOL.tab[src.col].slice(src.idx);
  if(!cards.length || !cards[0]) return;
  const lead = cards[0];
  const destTop = SOL.tab[destCol][SOL.tab[destCol].length-1];
  if(!solCanStackTableau(lead, destTop)){ solMsg('That one won\u2019t sit there.'); SOL.sel=null; solRender(); return; }
  solSnapshot();
  if(src.pile==='waste') SOL.waste.pop();
  else if(src.pile==='found') SOL.found[src.suit].pop();
  else SOL.tab[src.col].splice(src.idx);
  SOL.tab[destCol].push(...cards);
  const remain = src.pile==='tab' ? SOL.tab[src.col] : null;
  if(remain && remain.length) remain[remain.length-1].up = true;
  SOL.sel = null; SOL.moves++;
  solMsg('Nice.'); solRender();
}
function solTryMoveToFoundation(suitId){
  if(!SOL.sel) return;
  const {src} = SOL.sel;
  let card;
  if(src.pile==='waste') card = SOL.waste[SOL.waste.length-1];
  else card = SOL.tab[src.col]?.[SOL.tab[src.col].length-1];
  if(!card || !solCanStackFoundation(card, SOL.found[suitId], suitId)){ solMsg('Not the right lemon for that pile.'); SOL.sel=null; solRender(); return; }
  solSnapshot();
  if(src.pile==='waste') SOL.waste.pop(); else { SOL.tab[src.col].pop(); const t=SOL.tab[src.col]; if(t.length) t[t.length-1].up=true; }
  SOL.found[suitId].push(card);
  SOL.sel = null; SOL.moves++;
  solRender();
  if(solWon()) setTimeout(solWinNow, 50);
}
function solClickTableauCard(col, idx){
  const card = SOL.tab[col][idx];
  if(!card.up){
    if(idx === SOL.tab[col].length-1){ card.up = true; solRender(); }
    return;
  }
  if(SOL.sel){
    if(SOL.sel.src.pile==='tab' && SOL.sel.src.col===col){ SOL.sel=null; solRender(); return; }
    solTryMoveTo(col); return;
  }
  /* double-tap-like convenience: tapping the very top card of a column tries the foundation first */
  if(idx === SOL.tab[col].length-1){
    const target = solAutoFoundationTarget(card);
    if(target){ solSnapshot(); SOL.found[target].push(card); SOL.tab[col].pop(); const t=SOL.tab[col]; if(t.length) t[t.length-1].up=true; SOL.moves++; solRender();
      if(solWon()) setTimeout(solWinNow, 50); return; }
  }
  solSelect({pile:'tab', col, idx});
}
function solClickWaste(){
  if(!SOL.waste.length) return;
  if(SOL.sel && SOL.sel.src.pile==='waste'){ SOL.sel=null; solRender(); return; }
  if(!SOL.sel){
    const card = SOL.waste[SOL.waste.length-1];
    const target = solAutoFoundationTarget(card);
    if(target){
      solSnapshot();
      SOL.found[target].push(SOL.waste.pop());
      SOL.moves++; solRender();
      if(solWon()) solWinNow();
      return;
    }
  }
  solSelect({pile:'waste'});
}
function solWinNow(){
  clearInterval(SOL.tInt);
  const sec = Math.floor((Date.now()-SOL.t0)/1000);
  solMsg(`Full grove in ${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')} \u00b7 ${SOL.moves} moves. Every lemon home. \uD83C\uDF4B`);
}
function solClickFoundation(suitId){
  if(SOL.sel){ solTryMoveToFoundation(suitId); return; }
  const pile = SOL.found[suitId];
  if(pile.length) solSelect({pile:'found', suit:suitId});
}
function solRender(){
  const stockEl = $('#solstock'), wasteEl = $('#solwaste'), foundEl = $('#solfound'), tabEl = $('#soltableau');
  if(!stockEl) return;
  const mv = $('#solmoves'); if(mv) mv.textContent = SOL.moves;
  stockEl.innerHTML = SOL.stock.length ? solCardBack() : `<div class="solcard solempty">&#8635;</div>`;
  wasteEl.innerHTML = SOL.waste.length ? solCardFace(SOL.waste[SOL.waste.length-1]) : `<div class="solcard solempty"></div>`;
  wasteEl.classList.toggle('sel', !!(SOL.sel && SOL.sel.src.pile==='waste'));
  wasteEl.onclick = solClickWaste;
  foundEl.innerHTML = SOL_SUITS.map(s=>{
    const pile = SOL.found[s.id], top = pile[pile.length-1];
    const sel = SOL.sel && SOL.sel.src.pile==='found' && SOL.sel.src.suit===s.id;
    return `<div class="solfoundslot${sel?' sel':''}" data-suit="${s.id}">${top ? solCardFace(top) : `<div class="solcard solempty">${s.glyph}</div>`}</div>`;
  }).join('');
  foundEl.querySelectorAll('[data-suit]').forEach(elx=>elx.addEventListener('click', ()=>solClickFoundation(elx.dataset.suit)));
  tabEl.innerHTML = SOL.tab.map((col,ci)=>{
    const sel = SOL.sel && SOL.sel.src.pile==='tab' && SOL.sel.src.col===ci;
    return `<div class="solcol" data-col="${ci}">${col.map((c,ri)=>{
      const lifted = sel && ri >= SOL.sel.src.idx;
      return `<div class="solslot${lifted?' lifted':''}" style="--i:${ri}" data-idx="${ri}">${c.up ? solCardFace(c) : solCardBack()}</div>`;
    }).join('') || '<div class="solslot solemptycol" data-idx="0"></div>'}</div>`;
  }).join('');
  tabEl.querySelectorAll('.solcol').forEach(colEl=>{
    const ci = +colEl.dataset.col;
    colEl.addEventListener('click', e=>{
      const slot = e.target.closest('.solslot');
      const idx = slot ? +slot.dataset.idx : SOL.tab[ci].length-1;
      if(SOL.tab[ci].length && slot && idx < SOL.tab[ci].length) solClickTableauCard(ci, idx);
      else solTryMoveTo(ci);
    });
  });
}

/* =====================================================================
   SECRET DOOR #6: SOUR ASCENT v3 (click "Next new" in the Moon screen)
   Endless bounce-climber. Lemons is always bouncing; steer him left and
   right (tilt your phone, hold a side, or use arrow keys) onto platforms
   and climb forever. Springs launch, brown ledges crumble, sour flies
   want you dead unless you land on their heads. Fall off the bottom and
   the run ends. Points = how high you got. Best score sticks around.
   ===================================================================== */
const JMP_C = { G:2400, BOUNCE:1120, SPRING:1800, VXMAX:560, STEER:13,
  TILT_SENS:20, LOGICAL_W:500, DEATH_BELOW:640, STEP:1/120, PLAT_H:14 };
const ASC = { open:false, raf:0, keys:{}, touchDir:0, gamma:null, tiltOn:false,
  p:null, plats:[], foes:[], cam:0, genY:0, foeY:1200, dead:false,
  score:0, best:0, anim:{landT:0}, quip:null, acc:0, rng:null, saveT:null };

/* zone palettes cycle forever as you climb */
const ASC_ZONES = [
  { name:'The Lemon Grove',   skyT:'#BFE3EE', skyB:'#FFF6D8', plat:'#8A6B33', platTop:'#B7E07A', dust:'rgba(255,253,244,.7)' },
  { name:'The Juice Factory', skyT:'#E8D9B8', skyB:'#FFE9C2', plat:'#5C5648', platTop:'#F4CE3E', dust:'rgba(35,36,27,.14)' },
  { name:'The Pulp Caves',    skyT:'#7A4A22', skyB:'#C97B2E', plat:'#E0972C', platTop:'#FBF0B2', dust:'rgba(244,206,62,.75)' },
  { name:'The Freezer Aisle', skyT:'#274A5C', skyB:'#9FD8E8', plat:'#7FB6C9', platTop:'#FFFDF4', dust:'rgba(255,253,244,.8)' }
];
function ascZoneFor(y){ return ASC_ZONES[Math.floor(Math.max(0,y)/1700) % ASC_ZONES.length]; }

/* ---------- audio (shared with CITRUS MX) ---------- */
function ascAudio(){
  if(ASC.actx === undefined){
    try{ ASC.actx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){ ASC.actx = null; }
  }
  return ASC.actx;
}
function ascBeep(f0, f1, dur, type='square', gain=0.05){
  const a = ascAudio(); if(!a) return;
  try{
    const o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1,1), a.currentTime+dur);
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime+dur);
    o.connect(g).connect(a.destination);
    o.start(); o.stop(a.currentTime+dur+0.02);
  }catch(e){}
}

/* ---------- world generation: pure + testable ---------- */
function jmpRng(seed){
  return function(){ seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function jmpDifficulty(y){ return Math.min(1, y/9000); } /* 0 → 1 over the first 900 pts */
function jmpMakePlat(rng, y, lastSolidY){
  const d = jmpDifficulty(y);
  const w = 96 - d*38;
  const x = (rng()*2-1) * (JMP_C.LOGICAL_W/2 - w/2 - 8);
  let type = 'n';
  const roll = rng();
  const mustSolid = (y - lastSolidY) > 150; /* breakables only allowed close above a solid */ /* never strand the player on crumble-only gaps */
  if(!mustSolid){
    if(roll < 0.06 + d*0.14) type = 'b';           /* breakable */
    else if(roll < 0.06 + d*0.14 + d*0.22) type = 'm'; /* moving */
  }
  const pl = { x, y, w, type, broken:false, phase: rng()*Math.PI*2, amp: 40 + rng()*70, spd: 0.9 + rng()*0.9, cx:x };
  pl.spring = type === 'n' && rng() < 0.08;
  return pl;
}
function jmpGenerateTo(targetY){
  while(ASC.genY < targetY){
    const d = jmpDifficulty(ASC.genY);
    ASC.genY += 70 + ASC.rng()*(60 + d*100);            /* single hop: 70–230px */
    ASC.genY = Math.min(ASC.genY, (ASC.lastSolidY||0) + 235); /* never outrun the bounce (261px) */
    const pl = jmpMakePlat(ASC.rng, ASC.genY, ASC.lastSolidY||0);
    ASC.plats.push(pl);
    if(pl.type !== 'b') ASC.lastSolidY = pl.y;
    if(ASC.genY > 1100 && ASC.genY > ASC.foeY){
      ASC.foeY = ASC.genY + 800 + ASC.rng()*900 * (1.4 - d*0.6);
      ASC.foes.push({ x:(ASC.rng()*2-1)*(JMP_C.LOGICAL_W/2-40), y:ASC.genY + 60,
        phase: ASC.rng()*Math.PI*2, amp: 30 + ASC.rng()*50, dead:false });
    }
  }
  /* cull what's far below the camera */
  ASC.plats = ASC.plats.filter(pl=> pl.y > ASC.cam - 1400);
  ASC.foes = ASC.foes.filter(f=> f.y > ASC.cam - 1400);
}

/* ---------- physics: fixed step, pure enough to test ---------- */
function jmpWrap(x){
  const half = JMP_C.LOGICAL_W/2;
  if(x < -half) return x + JMP_C.LOGICAL_W;
  if(x > half) return x - JMP_C.LOGICAL_W;
  return x;
}
function jmpStep(p, plats, foes, dt, now){
  const ev = { bounced:false, spring:false, broke:false, stomped:false, died:false };
  const prevY = p.y;
  p.vy -= JMP_C.G*dt;
  p.y += p.vy*dt;
  p.x = jmpWrap(p.x + p.vx*dt);
  /* platform bounce: only while falling, only crossing the top this step */
  if(p.vy < 0){
    for(const pl of plats){
      if(pl.broken) continue;
      const px = pl.type==='m' ? pl.cx + Math.sin(now*pl.spd + pl.phase)*pl.amp : pl.x;
      const top = pl.y + JMP_C.PLAT_H;
      if(prevY >= top && p.y <= top && Math.abs(p.x - px) < pl.w/2 + 14){
        if(pl.type === 'b'){ pl.broken = true; ev.broke = true; continue; } /* crumbles, no bounce */
        p.y = top;
        p.vy = pl.spring ? JMP_C.SPRING : JMP_C.BOUNCE;
        ev.bounced = true; ev.spring = pl.spring;
        break;
      }
    }
  }
  /* sour flies: player spans feet (p.y) to head (~p.y+58 core) */
  for(const f of foes){
    if(f.dead) continue;
    const fx = f.x + Math.sin(now*1.3 + f.phase)*f.amp;
    if(Math.abs(p.x - fx) < 26 && p.y < f.y + 14 && p.y + 58 > f.y - 12){
      if(p.vy < 0 && p.y > f.y){ f.dead = true; p.vy = JMP_C.BOUNCE*1.05; ev.stomped = true; }
      else ev.died = true;
    }
  }
  return ev;
}

/* ---------- Lemons, mid-flight forever ---------- */
function ascDrawLemons(ctx, sx, sy, p, now){
  const panic = p.vy < -900;
  const rising = p.vy > 60;
  const landSquash = Math.max(0, ASC.anim.landT) / 0.12;
  const lean = Math.max(-1, Math.min(1, p.vx/JMP_C.VXMAX)) * 0.2;
  const sYs = landSquash > 0 ? 0.82 : 1;
  const sXs = landSquash > 0 ? 1.15 : 1;
  const SKIN='#E5A96B', SKIND='#C98A4E', SHORT='#4E7A3A', INK='#23241B', ZEST='#F4CE3E', SNK='#FFFDF4';
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(lean);
  ctx.scale(p.facing||1, 1);
  ctx.scale(sXs, sYs);
  /* sneakers */
  ctx.fillStyle = SNK;
  ctx.fillRect(-15, -7, 14, 7); ctx.fillRect(1, -7, 14, 7);
  ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
  ctx.strokeRect(-15, -7, 14, 7); ctx.strokeRect(1, -7, 14, 7);
  ctx.fillStyle = ZEST; ctx.fillRect(-15, -4.5, 14, 2); ctx.fillRect(1, -4.5, 14, 2);
  /* legs — tucked slightly when rising */
  const tuck = rising ? 4 : 0;
  ctx.fillStyle = SKIN;
  ctx.fillRect(-11, -21+tuck, 9, 15-tuck); ctx.fillRect(2, -21+tuck, 9, 15-tuck);
  /* shorts */
  ctx.fillStyle = SHORT;
  ctx.beginPath();
  ctx.moveTo(-14, -34); ctx.lineTo(14, -34); ctx.lineTo(16, -20); ctx.lineTo(3, -20);
  ctx.lineTo(0, -26); ctx.lineTo(-3, -20); ctx.lineTo(-16, -20); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.fillStyle = INK; ctx.fillRect(-14, -35, 28, 3);
  /* torso */
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.moveTo(-10, -34); ctx.lineTo(-18, -56); ctx.lineTo(18, -56); ctx.lineTo(10, -34);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.strokeStyle = SKIND; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(-9,-50); ctx.lineTo(-1,-48); ctx.moveTo(9,-50); ctx.lineTo(1,-48);
  ctx.moveTo(-4,-44); ctx.lineTo(4,-44); ctx.stroke();
  /* arms: up while rising, flail in panic, braced otherwise */
  ctx.fillStyle = SKIN; ctx.strokeStyle = INK;
  function arm(side){
    const sh = {x:side*16, y:-53};
    let el, fi;
    if(rising){ el = {x:side*23, y:-62}; fi = {x:side*17, y:-75}; }
    else if(panic){ const w = Math.sin(now*14 + side); el = {x:side*(22+w*3), y:-52+w*8}; fi = {x:side*(26-w*4), y:-63+w*11}; }
    else { el = {x:side*23, y:-46}; fi = {x:side*19, y:-56}; }
    ctx.beginPath(); ctx.arc(sh.x, sh.y, 7.5, 0, Math.PI*2); ctx.fill();
    ctx.lineWidth = 1.4; ctx.stroke();
    ctx.lineCap = 'round';
    ctx.strokeStyle = SKIN; ctx.lineWidth = 11;
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(el.x, el.y); ctx.stroke();
    ctx.lineWidth = 8.5;
    ctx.beginPath(); ctx.moveTo(el.x, el.y); ctx.lineTo(fi.x, fi.y); ctx.stroke();
    ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(fi.x, fi.y, 5, 0, Math.PI*2); ctx.fillStyle = SKIN; ctx.fill(); ctx.stroke();
    return {sh, el};
  }
  const aR = arm(1), aL = arm(-1);
  /* tattoos */
  const tat = {x:(aL.sh.x+aL.el.x)/2, y:(aL.sh.y+aL.el.y)/2};
  ctx.beginPath(); ctx.arc(tat.x, tat.y, 3, 0, Math.PI*2); ctx.fillStyle = ZEST; ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 0.9; ctx.stroke();
  /* head */
  const hy = -66;
  ctx.beginPath(); ctx.ellipse(0, hy, 12.5, 10, 0, 0, Math.PI*2);
  ctx.fillStyle = ZEST; ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(-13.5, hy, 2.6, 1.9, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(13.5, hy, 2.6, 1.9, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = SHORT;
  ctx.beginPath(); ctx.moveTo(3, hy-9); ctx.quadraticCurveTo(9, hy-17, 16, hy-14);
  ctx.quadraticCurveTo(11, hy-9, 3, hy-9); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = INK;
  if(panic){
    ctx.fillStyle = '#FFFDF4';
    ctx.beginPath(); ctx.arc(2, hy-2, 3.4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(9, hy-2, 3.4, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(2.6, hy-1.6, 1.4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(9.6, hy-1.6, 1.4, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6, hy+4.5, 2.6, 3.4, 0, 0, Math.PI*2); ctx.fill();
  }else{
    ctx.lineWidth = 2; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.moveTo(-1, hy-5.5); ctx.lineTo(4.5, hy-4); ctx.moveTo(11.5, hy-5.5); ctx.lineTo(6.5, hy-4); ctx.stroke();
    ctx.fillRect(1.5, hy-2.5, 2.6, 3.2); ctx.fillRect(7.5, hy-2.5, 2.6, 3.2);
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(2, hy+5); ctx.lineTo(10, hy+4.4); ctx.stroke();
  }
  ctx.restore();
}

/* ---------- render ---------- */
function jmpDrawPlat(ctx, pl, sx, sy, zone, s){
  const w = pl.w*s, h = JMP_C.PLAT_H*s;
  if(pl.type === 'b'){
    ctx.globalAlpha = pl.broken ? 0.25 : 1;
    ctx.fillStyle = '#8A6B33';
    ctx.fillRect(sx-w/2, sy, w, h);
    ctx.strokeStyle = 'rgba(35,36,27,.5)'; ctx.lineWidth = 1.4;
    ctx.strokeRect(sx-w/2, sy, w, h);
    ctx.beginPath();
    ctx.moveTo(sx-w*0.22, sy); ctx.lineTo(sx-w*0.1, sy+h*0.6); ctx.lineTo(sx+w*0.05, sy+h*0.3); ctx.lineTo(sx+w*0.2, sy+h);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = zone.plat;
  ctx.fillRect(sx-w/2, sy, w, h);
  ctx.strokeStyle = 'rgba(35,36,27,.4)'; ctx.lineWidth = 1.4;
  ctx.strokeRect(sx-w/2, sy, w, h);
  ctx.fillStyle = zone.platTop;
  ctx.fillRect(sx-w/2, sy, w, 4*s);
  if(pl.type === 'm'){
    ctx.fillStyle = 'rgba(35,36,27,.55)';
    ctx.beginPath(); ctx.moveTo(sx-w/2+5, sy+h/2); ctx.lineTo(sx-w/2+11, sy+3); ctx.lineTo(sx-w/2+11, sy+h-3); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx+w/2-5, sy+h/2); ctx.lineTo(sx+w/2-11, sy+3); ctx.lineTo(sx+w/2-11, sy+h-3); ctx.closePath(); ctx.fill();
  }
  if(pl.spring){
    ctx.strokeStyle = '#23241B'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx-7, sy); ctx.lineTo(sx-4, sy-6); ctx.lineTo(sx, sy-2); ctx.lineTo(sx+4, sy-8); ctx.lineTo(sx+7, sy-4);
    ctx.stroke();
    ctx.fillStyle = '#F4CE3E';
    ctx.fillRect(sx-9, sy-12, 18, 4);
    ctx.strokeStyle = 'rgba(35,36,27,.6)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(sx-9, sy-12, 18, 4);
  }
}
function jmpDrawFoe(ctx, f, sx, sy, now){
  const bob = Math.sin(now*5 + f.phase)*3;
  ctx.save(); ctx.translate(sx, sy+bob);
  const flap = Math.sin(now*22 + f.phase)*0.5;
  ctx.fillStyle = 'rgba(244,206,62,.85)';
  ctx.beginPath(); ctx.ellipse(-14, -6, 9, 4.5, -0.5+flap, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(14, -6, 9, 4.5, 0.5-flap, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 0, 12, 10, 0, 0, Math.PI*2);
  ctx.fillStyle = '#23241B'; ctx.fill();
  ctx.strokeStyle = '#F4CE3E'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(-8, 3); ctx.lineTo(8, 3); ctx.stroke(); /* sour stripe */
  ctx.fillStyle = '#FFFDF4';
  ctx.beginPath(); ctx.arc(-4, -3, 2.8, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -3, 2.8, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#23241B';
  ctx.beginPath(); ctx.arc(-3.4, -2.6, 1.2, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(4.6, -2.6, 1.2, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}
function jmpRender(ctx, canvas, now){
  const W = canvas.width, H = canvas.height;
  const zone = ascZoneFor(ASC.cam);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, zone.skyT); g.addColorStop(1, zone.skyB);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const s = Math.min(W / JMP_C.LOGICAL_W, 1.6);
  const camX = W/2, camY = H*0.55;
  const toS = (x, y) => [camX + x*s, camY - (y - ASC.cam)*s];
  /* faint zone dust */
  ctx.fillStyle = zone.dust;
  for(let k=0;k<14;k++){
    const dy = ((k*473 + now*22) % 2200);
    const [dxs, dys] = toS(((k*197)%JMP_C.LOGICAL_W)-JMP_C.LOGICAL_W/2, ASC.cam - 900 + dy);
    if(dys>-10 && dys<H+10){ ctx.beginPath(); ctx.arc(dxs, dys, 1.6+((k*7)%3), 0, Math.PI*2); ctx.fill(); }
  }
  for(const pl of ASC.plats){
    const px = pl.type==='m' ? pl.cx + Math.sin(now*pl.spd + pl.phase)*pl.amp : pl.x;
    const [sx, sy] = toS(px, pl.y + JMP_C.PLAT_H);
    if(sy < -30 || sy > H+30) continue;
    jmpDrawPlat(ctx, pl, sx, sy, ascZoneFor(pl.y), s);
  }
  for(const f of ASC.foes){
    if(f.dead) continue;
    const fx = f.x + Math.sin(now*1.3 + f.phase)*f.amp;
    const [sx, sy] = toS(fx, f.y);
    if(sy < -40 || sy > H+40) continue;
    jmpDrawFoe(ctx, f, sx, sy, now);
  }
  const [psx, psy] = toS(ASC.p.x, ASC.p.y);
  ascDrawLemons(ctx, psx, psy, ASC.p, now);
  if(ASC.quip && ASC.quip.t > 0){
    ctx.globalAlpha = Math.min(1, ASC.quip.t);
    ctx.font = '700 15px Instrument Sans, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#23241B';
    ctx.fillText(ASC.quip.text, psx, psy - 96*Math.min(s,1));
    ctx.globalAlpha = 1;
  }
  if(ASC.dead){
    ctx.fillStyle = 'rgba(21,21,15,.55)'; ctx.fillRect(0,0,W,H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#FFFDF4';
    ctx.font = '640 34px Fraunces, Georgia, serif';
    ctx.fillText('SQUEEZED.', W/2, H*0.42);
    ctx.font = '600 16px Instrument Sans, sans-serif';
    ctx.fillText(`${ASC.score} pts \u00b7 best ${ASC.best}`, W/2, H*0.42 + 32);
    ctx.font = '500 13px Instrument Sans, sans-serif';
    ctx.fillStyle = 'rgba(255,253,244,.75)';
    ctx.fillText('ontouchstart' in window ? 'tap to re-climb' : 'space to re-climb', W/2, H*0.42 + 58);
  }
}

/* ---------- lifecycle ---------- */
const JMP_DEATH_QUIPS = ['gravity is a hater','the flies unionized','MY GAINS!','citrus has fallen'];
function jmpReset(){
  ASC.p = { x:0, y:40, vx:0, vy:JMP_C.BOUNCE, facing:1 };
  ASC.plats = [{ x:0, y:0, w:170, type:'n', broken:false, spring:false, cx:0, phase:0, amp:0, spd:0 }];
  ASC.foes = [];
  ASC.cam = 0; ASC.genY = 0; ASC.foeY = 1200; ASC.lastSolidY = 0;
  ASC.dead = false; ASC.score = 0; ASC.quip = null; ASC.acc = 0;
  ASC.rng = jmpRng((Date.now() & 0xffff) | 1); /* fresh tower every run */
  jmpGenerateTo(2400);
}
function openAscent(){
  if(ASC.open) return;
  closeMoonScreen();
  ASC.open = true;
  ASC.best = (store.get('lemons.jump')?.best) || 0;
  jmpReset();
  const touch = 'ontouchstart' in window;
  const needsTiltPerm = touch && typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';
  const el = document.createElement('div');
  el.id = 'ascmodal';
  el.innerHTML = `
    <canvas id="asccanvas"></canvas>
    <div class="lctop">
      <span class="mstitle">SOUR ASCENT<span class="dot">.</span></span>
      <span class="asctag">endless citrus bounce</span>
      <span style="flex:1"></span>
      ${needsTiltPerm ? '<button class="linkish" id="asctilt">enable tilt</button>' : ''}
      <button class="modalclose lcclose" id="ascclose" aria-label="Close">&times;</button>
    </div>
    <div class="ascstats">
      <span><b id="ascpts">0</b> pts</span>
      <span><b id="ascbest">${ASC.best}</b> best</span>
      <span id="asczone">${ASC_ZONES[0].name}</span>
    </div>
    <p class="lchint">${touch
      ? (needsTiltPerm ? 'tilt to steer (tap enable tilt) \u00b7 or hold a side of the screen \u00b7 bounce on heads, dodge the rest'
                       : 'tilt to steer \u00b7 or hold a side of the screen \u00b7 bounce on heads, dodge the rest')
      : '\u2190\u2192 or A/D to steer \u00b7 wrap around the edges \u00b7 bounce on heads, dodge the rest'}</p>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#ascclose').addEventListener('click', closeAscent);
  document.addEventListener('keydown', moonEsc);

  ASC.onKeyDown = e=>{
    if(e.code==='ArrowLeft'||e.code==='KeyA') ASC.keys.left = true;
    if(e.code==='ArrowRight'||e.code==='KeyD') ASC.keys.right = true;
    if((e.code==='Space'||e.code==='Enter') && ASC.dead) jmpReset();
    if(['ArrowLeft','ArrowRight','Space','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
  };
  ASC.onKeyUp = e=>{
    if(e.code==='ArrowLeft'||e.code==='KeyA') ASC.keys.left = false;
    if(e.code==='ArrowRight'||e.code==='KeyD') ASC.keys.right = false;
  };
  window.addEventListener('keydown', ASC.onKeyDown);
  window.addEventListener('keyup', ASC.onKeyUp);

  ASC.onTilt = e=>{ if(e.gamma != null){ ASC.gamma = e.gamma; ASC.tiltOn = true; } };
  if(touch){
    if(needsTiltPerm){
      $('#asctilt').addEventListener('click', ()=>{
        DeviceOrientationEvent.requestPermission().then(res=>{
          if(res === 'granted'){ window.addEventListener('deviceorientation', ASC.onTilt); $('#asctilt').remove(); }
        }).catch(()=>{});
      });
    }else{
      window.addEventListener('deviceorientation', ASC.onTilt);
    }
    /* fallback / additional: hold a side of the screen to steer, tap to restart */
    el.addEventListener('touchstart', e=>{
      if(e.target.closest('.lctop')) return;
      if(ASC.dead){ jmpReset(); return; }
      const t = e.changedTouches[0];
      ASC.touchDir = t.clientX < window.innerWidth/2 ? -1 : 1;
    }, {passive:true});
    el.addEventListener('touchend', ()=>{ ASC.touchDir = 0; }, {passive:true});
    el.addEventListener('touchcancel', ()=>{ ASC.touchDir = 0; }, {passive:true});
  }
  jmpStartLoop();
}
function jmpStartLoop(){
  const canvas = $('#asccanvas'), ctx = canvas.getContext('2d');
  function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  ASC.onResize = resize;
  window.addEventListener('resize', resize);
  let last = performance.now();
  function tick(now){
    ASC.raf = requestAnimationFrame(tick);
    const dt = Math.min((now-last)/1000, 0.05); last = now;
    const t = now/1000;
    if(!ASC.dead){
      /* steering: tilt beats touch-hold beats keys, whichever is active */
      let target = 0;
      const keyDir = (ASC.keys.right?1:0) - (ASC.keys.left?1:0);
      if(ASC.touchDir) target = ASC.touchDir * JMP_C.VXMAX;
      else if(ASC.tiltOn && ASC.gamma != null) target = Math.max(-JMP_C.VXMAX, Math.min(JMP_C.VXMAX, ASC.gamma * JMP_C.TILT_SENS));
      else target = keyDir * JMP_C.VXMAX;
      if(keyDir) target = keyDir * JMP_C.VXMAX; /* desktop keys always win */
      ASC.p.vx += (target - ASC.p.vx) * Math.min(1, dt * JMP_C.STEER);
      if(Math.abs(ASC.p.vx) > 30) ASC.p.facing = ASC.p.vx > 0 ? 1 : -1;

      ASC.acc += dt;
      while(ASC.acc >= JMP_C.STEP){
        ASC.acc -= JMP_C.STEP;
        const ev = jmpStep(ASC.p, ASC.plats, ASC.foes, JMP_C.STEP, t);
        if(ev.bounced){ ASC.anim.landT = 0.12; ascBeep(ev.spring?280:170, ev.spring?720:340, ev.spring?0.16:0.09, 'sine', 0.05); }
        if(ev.broke) ascBeep(150, 70, 0.1, 'sine', 0.05);
        if(ev.stomped){ ascBeep(300, 560, 0.12, 'triangle', 0.06); ASC.quip = {text:'fly? denied.', t:1.1}; }
        if(ev.died){
          ASC.dead = true;
          ASC.quip = null;
          ascBeep(220, 50, 0.35, 'sawtooth', 0.08);
          jmpSaveBest();
          break;
        }
      }
      /* score + camera only ever go up */
      const pts = Math.max(0, Math.floor(ASC.p.y/10));
      if(pts > ASC.score) ASC.score = pts;
      if(ASC.p.y > ASC.cam) ASC.cam += (ASC.p.y - ASC.cam) * Math.min(1, dt*7);
      jmpGenerateTo(ASC.cam + 2000);
      /* the fall that ends it */
      if(ASC.p.y < ASC.cam - JMP_C.DEATH_BELOW){
        ASC.dead = true;
        ascBeep(220, 50, 0.35, 'sawtooth', 0.08);
        jmpSaveBest();
      }
    }
    if(ASC.anim.landT > 0) ASC.anim.landT -= dt;
    if(ASC.quip) ASC.quip.t -= dt;
    const ps = $('#ascpts'); if(ps) ps.textContent = ASC.score;
    const bs = $('#ascbest'); if(bs) bs.textContent = Math.max(ASC.best, ASC.score);
    const zn = $('#asczone'); const z = ascZoneFor(ASC.cam);
    if(zn && zn.textContent !== z.name) zn.textContent = z.name;
    jmpRender(ctx, canvas, t);
  }
  ASC.raf = requestAnimationFrame(tick);
}
function jmpSaveBest(){
  ASC.best = Math.max(ASC.best, ASC.score);
  clearTimeout(ASC.saveT);
  ASC.saveT = setTimeout(()=>store.set('lemons.jump', {best:ASC.best}), 200);
}
function closeAscent(){
  if(!ASC.open) return;
  ASC.open = false;
  cancelAnimationFrame(ASC.raf);
  clearTimeout(ASC.saveT);
  jmpSaveBest();
  window.removeEventListener('keydown', ASC.onKeyDown);
  window.removeEventListener('keyup', ASC.onKeyUp);
  window.removeEventListener('resize', ASC.onResize);
  window.removeEventListener('deviceorientation', ASC.onTilt);
  ASC.keys = {}; ASC.touchDir = 0; ASC.tiltOn = false; ASC.gamma = null;
  const el = $('#ascmodal'); if(el) el.remove();
  document.body.style.overflow = '';
}

/* =====================================================================
   SECRET DOOR #7: CITRUS MX (click "Next full" in the Moon screen)
   A physics BMX game. Up = gas, Down = brake/reverse, Left/Right = tilt.
   Same beefy Lemons, now on a zest-framed BMX with lemon-slice wheels.
   Two-wheel Verlet physics on authored terrain, six levels, best times.
   ===================================================================== */
const BMX_C = { G:1500, DRIVE:1380, REVERSE:700, WHEEL_R:15, WB:54,
  STEP:1/120, FRICTION:0.989, BRAKE:0.90, REST:0.14, MAXTILT:0.11 };
const BMX = { open:false, raf:0, keys:{}, level:0, terrain:null, bike:null,
  t0:0, time:0, crashT:0, doneT:0, dist:0, quip:null, saveT:null, acc:0 };

/* ---------- levels: authored control points, y-down world ---------- */
const BMX_LEVELS = [
  { name:'Grove Rollers', pal:0, finish:2500, pts:[[0,420],[300,420],[560,380],[820,430],[1080,370],[1360,430],[1650,380],[1950,430],[2250,400],[2600,410],[3000,410]] },
  { name:'The Big Ramp', pal:0, finish:2700, pts:[[0,420],[350,420],[700,400],[950,330],[1080,300],[1140,470],[1450,470],[1750,420],[2050,440],[2380,400],[2800,410],[3200,410]] },
  { name:'Pulp Bumps', pal:2, finish:2900, pts:[[0,420],[300,420],[480,390],[620,430],[760,390],[900,430],[1040,390],[1180,430],[1320,390],[1500,440],[1750,380],[2000,440],[2250,390],[2550,430],[2950,410],[3350,410]] },
  { name:'Juice Pipes', pal:1, finish:3000, pts:[[0,420],[320,420],[600,340],[840,460],[1100,320],[1360,470],[1650,330],[1950,460],[2250,350],[2600,430],[3050,410],[3450,410]] },
  { name:'Fizz Gap', pal:2, finish:3100, pts:[[0,420],[380,420],[700,380],[900,320],[980,300],[1060,520],[1300,520],[1420,330],[1500,310],[1580,540],[1860,540],[2000,420],[2350,400],[2700,430],[3150,410],[3550,410]] },
  { name:'Citric Backbone', pal:1, finish:3600, pts:[[0,420],[300,420],[560,370],[760,430],[930,330],[1010,310],[1090,500],[1330,500],[1520,400],[1700,340],[1850,460],[2050,360],[2180,330],[2260,530],[2520,530],[2700,420],[2950,380],[3250,440],[3650,410],[4050,410]] }
];
const BMX_PALS = [
  { skyT:'#BFE3EE', skyB:'#FFF6D8', dirt:'#8A6B33', top:'#B7E07A', hill:'rgba(78,122,58,.35)' },
  { skyT:'#E8D9B8', skyB:'#FFE9C2', dirt:'#5C5648', top:'#F4CE3E', hill:'rgba(74,68,56,.4)' },
  { skyT:'#F7C98B', skyB:'#FFEFC9', dirt:'#C97B2E', top:'#FBF0B2', hill:'rgba(181,101,29,.3)' }
];

/* Catmull-Rom smoothed heightfield sampled every 8px — authored points in,
   smooth rideable terrain out. Pure + testable. */
function bmxBuildTerrain(level){
  const pts = level.pts, step = 8;
  const maxX = pts[pts.length-1][0];
  const hs = [];
  const cr = (p0,p1,p2,p3,t)=> 0.5*((2*p1) + (-p0+p2)*t + (2*p0-5*p1+4*p2-p3)*t*t + (-p0+3*p1-3*p2+p3)*t*t*t);
  let seg = 0;
  for(let x=0; x<=maxX; x+=step){
    while(seg < pts.length-2 && x > pts[seg+1][0]) seg++;
    const p1 = pts[seg], p2 = pts[Math.min(seg+1, pts.length-1)];
    const p0 = pts[Math.max(seg-1, 0)], p3 = pts[Math.min(seg+2, pts.length-1)];
    const t = (x - p1[0]) / Math.max(1, p2[0]-p1[0]);
    hs.push(cr(p0[1], p1[1], p2[1], p3[1], Math.max(0, Math.min(1, t))));
  }
  return { hs, step, maxX, finish: level.finish, name: level.name, pal: BMX_PALS[level.pal] };
}
function bmxHeightAt(ter, x){
  const fx = Math.max(0, Math.min(ter.maxX-1, x)) / ter.step;
  const i = Math.floor(fx), f = fx - i;
  const a = ter.hs[i], b = ter.hs[Math.min(i+1, ter.hs.length-1)];
  return a + (b-a)*f;
}
function bmxNormalAt(ter, x){
  const d = 6;
  const dy = bmxHeightAt(ter, x+d) - bmxHeightAt(ter, x-d);
  const len = Math.hypot(2*d, dy);
  /* y-down: surface tangent (2d, dy); normal points up-out of ground */
  return { tx:2*d/len, ty:dy/len, nx:dy/len, ny:-2*d/len };
}

/* ---------- bike: two Verlet wheels + rigid rod ---------- */
function bmxSpawnBike(ter){
  const x = 80, y = bmxHeightAt(ter, x) - BMX_C.WHEEL_R - 1;
  return {
    w:[{x:x, y:y, px:x, py:y, contact:false, spin:0},
       (()=>{ const fy = bmxHeightAt(ter, x+BMX_C.WB)-BMX_C.WHEEL_R-1; return {x:x+BMX_C.WB, y:fy, px:x+BMX_C.WB, py:fy, contact:false, spin:0}; })()]
  };
}
function bmxStep(bike, ter, input, dt){
  const ev = {crashed:false, finished:false};
  const [r, f] = bike.w;
  /* integrate (Verlet) */
  for(const w of bike.w){
    const vx = (w.x - w.px) * BMX_C.FRICTION, vy = (w.y - w.py) * BMX_C.FRICTION;
    w.px = w.x; w.py = w.y;
    w.x += vx; w.y += vy + BMX_C.G*dt*dt;
  }
  /* solve rod + ground a few times, interleaved for stability */
  for(const w of bike.w) w.contact = false; /* reset ONCE — solver iterations only ever set it */
  for(let it=0; it<3; it++){
    /* rod constraint */
    let dx = f.x - r.x, dy = f.y - r.y;
    const dist = Math.hypot(dx, dy) || 1;
    const corr = (dist - BMX_C.WB) / dist / 2;
    r.x += dx*corr; r.y += dy*corr;
    f.x -= dx*corr; f.y -= dy*corr;
    /* ground collision per wheel */
    for(const w of bike.w){
      const gy = bmxHeightAt(ter, w.x);
      if(w.y + BMX_C.WHEEL_R > gy - 1){ /* 1px grace so resting wheels stay driveable */
        w.contact = true;
        const pen = w.y + BMX_C.WHEEL_R - gy;
        if(pen > 0){
          const n = bmxNormalAt(ter, w.x);
          w.x += n.nx * pen * 0.6;
          w.y += n.ny * pen;
          /* velocity response: kill most normal velocity, keep tangential */
          let vx = w.x - w.px, vy = w.y - w.py;
          const vn = vx*n.nx + vy*n.ny, vt = vx*n.tx + vy*n.ty;
          const newVn = -vn * BMX_C.REST;
          let newVt = vt;
          if(input.down) newVt *= BMX_C.BRAKE;
          vx = n.nx*newVn + n.tx*newVt;
          vy = n.ny*newVn + n.ty*newVt;
          w.px = w.x - vx; w.py = w.y - vy;
        }
      }
    }
  }
  /* drive: if either wheel has grip, accelerate BOTH wheel masses equally
     along that surface — pure translation, zero drive-torque. This is what
     kills the instant-frontflip: per-wheel thrust was torquing the nose
     down every time the front wheel unweighted over a bump or crest. */
  const dirX = f.x - r.x, dirY = f.y - r.y;
  if(input.up || input.down){
    const gripW = r.contact ? r : (f.contact ? f : null);
    if(gripW){
      const n = bmxNormalAt(ter, gripW.x);
      const sign = (dirX*n.tx + dirY*n.ty) >= 0 ? 1 : -1;
      const a = input.up ? BMX_C.DRIVE : -BMX_C.REVERSE;
      for(const w of bike.w){
        w.x += n.tx * sign * a * dt * dt;
        w.y += n.ty * sign * a * dt * dt;
      }
    }
  }
  /* rotation controller (Trials-style): holding left/right steers the spin
     RATE toward a fixed target; releasing steers it back to zero fast. No
     impulse pile-up, no ringing — rotation is something you hold, not wind up.
     Right = lean forward (nose down), Left = lean back, world-consistent. */
  {
    const ux = dirX, uy = dirY, L = Math.hypot(ux, uy) || 1;
    const px = -uy/L, py = ux/L;
    const relx = (f.x - f.px) - (r.x - r.px), rely = (f.y - f.py) - (r.y - r.py);
    const wPerp = relx*px + rely*py;                     /* + = clockwise spin */
    const grounded = r.contact || f.contact;
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const T = 2.45 * (grounded ? 0.35 : 1);              /* ≈ 5.4 rad/s in the air */
    const targetW = dir * T;
    const rate = dir !== 0 ? 11 : 6;                     /* fast attack, faster stop */
    let delta = (targetW - wPerp) * Math.min(1, rate*dt);
    const CAP = 3.0;                                     /* bump-kick ceiling ≈ 6.7 rad/s */
    if(wPerp + delta > CAP) delta = CAP - wPerp;
    if(wPerp + delta < -CAP) delta = -CAP - wPerp;
    if(delta !== 0){
      const half = delta/2;
      /* velocity change via prev positions: v = x - px */
      f.px -= px*half; f.py -= py*half;
      r.px += px*half; r.py += py*half;
    }
  }
  /* wheel spin (visual) from tangential travel */
  for(const w of bike.w) w.spin += ((w.x - w.px)) / BMX_C.WHEEL_R;
  /* crash: rider head below the surface */
  const head = bmxHeadPos(bike);
  if(head.y > bmxHeightAt(ter, head.x) + 7) ev.crashed = true;
  /* finish: both wheels past the flag */
  if(r.x > ter.finish && f.x > ter.finish) ev.finished = true;
  return ev;
}
function bmxHeadPos(bike){
  const [r, f] = bike.w;
  const mx = (r.x+f.x)/2, my = (r.y+f.y)/2;
  const dx = f.x-r.x, dy = f.y-r.y, len = Math.hypot(dx,dy)||1;
  /* perpendicular "up" from the bike (y-down world → up is -normal) */
  return { x: mx - (-dy/len)*46, y: my - (dx/len)*46 };
}

/* ---------- drawing ---------- */
function bmxDrawWheel(ctx, w){
  ctx.save();
  ctx.translate(w.x, w.y);
  ctx.rotate(w.spin);
  ctx.beginPath(); ctx.arc(0, 0, BMX_C.WHEEL_R, 0, Math.PI*2);
  ctx.fillStyle = '#F4CE3E'; ctx.fill();
  ctx.lineWidth = 2.4; ctx.strokeStyle = '#23241B'; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, BMX_C.WHEEL_R-4.5, 0, Math.PI*2);
  ctx.fillStyle = '#FFFDF4'; ctx.fill();
  ctx.strokeStyle = '#F4CE3E'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath();
  for(let k=0;k<4;k++){ const a = k*Math.PI/4;
    ctx.moveTo(Math.cos(a)*(BMX_C.WHEEL_R-5), Math.sin(a)*(BMX_C.WHEEL_R-5));
    ctx.lineTo(-Math.cos(a)*(BMX_C.WHEEL_R-5), -Math.sin(a)*(BMX_C.WHEEL_R-5)); }
  ctx.stroke();
  ctx.restore();
}
function bmxDrawRig(ctx, bike, crashed, now){
  const [r, f] = bike.w;
  const dx = f.x-r.x, dy = f.y-r.y, len = Math.hypot(dx,dy)||1;
  const ux = dx/len, uy = dy/len;         /* along bike, rear→front */
  const px = -uy, py = ux;                /* bike-down (y-down world) */
  const at = (a,b)=>({x: r.x + ux*a - px*b, y: r.y + uy*a - py*b}); /* a along, b up */
  const crank = at(24, 4), seatTop = at(14, 26), barTop = at(50, 30);
  const INK='#23241B', ZEST='#F4CE3E', RIND='#DDB32A', SKIN='#E5A96B', SHORT='#4E7A3A';
  /* frame */
  ctx.strokeStyle = RIND; ctx.lineWidth = 4.6; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(r.x, r.y); ctx.lineTo(crank.x, crank.y);
  ctx.lineTo(f.x, f.y);
  ctx.moveTo(crank.x, crank.y); ctx.lineTo(seatTop.x, seatTop.y);
  ctx.moveTo(seatTop.x, seatTop.y); ctx.lineTo(r.x, r.y);
  ctx.moveTo(f.x, f.y); ctx.lineTo(barTop.x, barTop.y);
  ctx.stroke();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.4;
  /* seat + handlebar */
  ctx.strokeStyle = INK; ctx.lineWidth = 5; 
  ctx.beginPath(); ctx.moveTo(seatTop.x - ux*7, seatTop.y - uy*7); ctx.lineTo(seatTop.x + ux*7, seatTop.y + uy*7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(barTop.x - ux*5, barTop.y - uy*5); ctx.lineTo(barTop.x + ux*6, barTop.y + uy*6); ctx.stroke();
  /* rider: seated Lemons — hips on the seat, hands on the bars */
  const hip = at(15, 30), shoulder = at(26, 52), knee = at(30, 16);
  const headC = at(30, 64);
  /* legs to crank */
  ctx.strokeStyle = SKIN; ctx.lineWidth = 7.5; ctx.lineCap='round';
  const pedalA = bike.w[0].spin*0.9;
  const pedal = {x:crank.x + Math.cos(pedalA)*8, y:crank.y + Math.sin(pedalA)*8};
  ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(knee.x, knee.y); ctx.lineTo(pedal.x, pedal.y); ctx.stroke();
  /* shorts */
  ctx.strokeStyle = SHORT; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo((hip.x+knee.x)/2, (hip.y+knee.y)/2); ctx.stroke();
  /* torso (leaning forward) */
  ctx.strokeStyle = SKIN; ctx.lineWidth = 12;
  ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(shoulder.x, shoulder.y); ctx.stroke();
  /* huge arm to the bars */
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(barTop.x, barTop.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(shoulder.x, shoulder.y, 6.5, 0, Math.PI*2); ctx.fillStyle=SKIN; ctx.fill();
  ctx.strokeStyle=INK; ctx.lineWidth=1.2; ctx.stroke();
  /* bicep tattoo */
  const tat = {x:(shoulder.x+barTop.x)/2 - ux*6, y:(shoulder.y+barTop.y)/2 - uy*6};
  ctx.beginPath(); ctx.arc(tat.x, tat.y, 2.8, 0, Math.PI*2); ctx.fillStyle=ZEST; ctx.fill();
  ctx.strokeStyle=INK; ctx.lineWidth=0.8; ctx.stroke();
  /* lemon head */
  const ha = Math.atan2(uy, ux);
  ctx.save(); ctx.translate(headC.x, headC.y); ctx.rotate(ha);
  ctx.beginPath(); ctx.ellipse(0, 0, 11.5, 9.2, 0, 0, Math.PI*2);
  ctx.fillStyle = ZEST; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(12.5, 0, 2.4, 1.7, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(-12.5, 0, 2.4, 1.7, 0, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = SHORT;
  ctx.beginPath(); ctx.moveTo(-2, -8); ctx.quadraticCurveTo(3, -15, 10, -13);
  ctx.quadraticCurveTo(5, -8, -2, -8); ctx.closePath(); ctx.fill();
  ctx.strokeStyle=INK; ctx.lineWidth=1.1; ctx.stroke();
  ctx.fillStyle = INK;
  if(crashed){
    ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(2,-3); ctx.lineTo(6,1); ctx.moveTo(6,-3); ctx.lineTo(2,1);
    ctx.moveTo(8,-3); ctx.lineTo(11,0); ctx.moveTo(11,-3); ctx.lineTo(8,0); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(6, 4.5, 2.2, 2.8, 0, 0, Math.PI*2); ctx.fill();
  }else{
    ctx.lineWidth = 1.8; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.moveTo(1,-4.5); ctx.lineTo(5.5,-3.2); ctx.stroke();
    ctx.fillRect(3, -1.8, 2.4, 2.8); ctx.fillRect(8, -1.8, 2.4, 2.8);
    ctx.beginPath(); ctx.moveTo(3.5, 4.4); ctx.lineTo(10, 3.8); ctx.stroke();
  }
  ctx.restore();
  bmxDrawWheel(ctx, r); bmxDrawWheel(ctx, f);
}
function bmxRender(ctx, canvas, now){
  const W = canvas.width, H = canvas.height;
  const ter = BMX.terrain, pal = ter.pal;
  const [r, f] = BMX.bike.w;
  const bx = (r.x+f.x)/2, by = (r.y+f.y)/2;
  const camX = Math.max(0, Math.min(bx - W*0.38, ter.maxX - W + 40));
  const camY = by - H*0.55;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.skyT); g.addColorStop(1, pal.skyB);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  /* lemon sun + parallax hills */
  ctx.beginPath(); ctx.arc(W*0.78 - camX*0.05, 90 - camY*0.05, 34, 0, Math.PI*2);
  ctx.fillStyle = '#F4CE3E'; ctx.fill(); ctx.strokeStyle='#23241B'; ctx.lineWidth=2.4; ctx.stroke();
  ctx.fillStyle = pal.hill;
  for(let k=0;k<4;k++){
    const hx = ((k*730 - camX*0.3) % (W+800)) - 400;
    ctx.beginPath(); ctx.arc(hx, H*0.9 - camY*0.25, 240+k*40, Math.PI, 0); ctx.fill();
  }
  /* terrain */
  ctx.beginPath();
  const x0 = Math.max(0, Math.floor(camX/ter.step)-2), x1 = Math.min(ter.hs.length-1, Math.ceil((camX+W)/ter.step)+2);
  ctx.moveTo(x0*ter.step - camX, ter.hs[x0] - camY);
  for(let i=x0+1; i<=x1; i++) ctx.lineTo(i*ter.step - camX, ter.hs[i] - camY);
  ctx.lineTo(x1*ter.step - camX, H+40); ctx.lineTo(x0*ter.step - camX, H+40);
  ctx.closePath();
  ctx.fillStyle = pal.dirt; ctx.fill();
  ctx.strokeStyle = pal.top; ctx.lineWidth = 5; ctx.lineCap='round';
  ctx.beginPath();
  ctx.moveTo(x0*ter.step - camX, ter.hs[x0] - camY);
  for(let i=x0+1; i<=x1; i++) ctx.lineTo(i*ter.step - camX, ter.hs[i] - camY);
  ctx.stroke();
  /* finish flag */
  const fgx = ter.finish - camX, fgy = bmxHeightAt(ter, ter.finish) - camY;
  if(fgx > -40 && fgx < W+40){
    ctx.strokeStyle = '#23241B'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(fgx, fgy); ctx.lineTo(fgx, fgy-56); ctx.stroke();
    ctx.fillStyle = '#F4CE3E';
    ctx.beginPath(); ctx.moveTo(fgx+2, fgy-56); ctx.lineTo(fgx+30, fgy-48); ctx.lineTo(fgx+2, fgy-40); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(35,36,27,.6)'; ctx.lineWidth = 1.2; ctx.stroke();
  }
  ctx.save(); ctx.translate(-camX, -camY);
  bmxDrawRig(ctx, BMX.bike, BMX.crashT > 0, now);
  ctx.restore();
  /* quip */
  if(BMX.quip && BMX.quip.t > 0){
    ctx.globalAlpha = Math.min(1, BMX.quip.t);
    ctx.font = '700 16px Instrument Sans, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#23241B';
    ctx.fillText(BMX.quip.text, bx - camX, by - camY - 92);
    ctx.globalAlpha = 1;
  }
}

/* ---------- lifecycle ---------- */
const BMX_CRASH_QUIPS = ['face, meet grove','the helmet was cosmetic anyway','citrus down. citrus down.','physics remains undefeated','sponsors, look away'];
function bmxLoadLevel(i){
  BMX.level = Math.max(0, Math.min(BMX_LEVELS.length-1, i));
  BMX.terrain = bmxBuildTerrain(BMX_LEVELS[BMX.level]);
  BMX.bike = bmxSpawnBike(BMX.terrain);
  BMX.t0 = performance.now(); BMX.time = 0; BMX.crashT = 0; BMX.doneT = 0; BMX.quip = null;
  const lv = $('#bmxlevel'); if(lv) lv.textContent = `${BMX.level+1}/${BMX_LEVELS.length} \u00b7 ${BMX_LEVELS[BMX.level].name}`;
  const bt = $('#bmxbest'); if(bt){
    const best = (store.get('lemons.bmx')?.best||{})[BMX.level];
    bt.textContent = best ? (best/1000).toFixed(1)+'s best' : '\u2014';
  }
}
function openBmx(){
  if(BMX.open) return;
  closeMoonScreen();
  BMX.open = true;
  const saved = store.get('lemons.bmx');
  const startLevel = saved?.level || 0;
  const touch = 'ontouchstart' in window;
  const el = document.createElement('div');
  el.id = 'bmxmodal';
  el.innerHTML = `
    <canvas id="bmxcanvas"></canvas>
    <div class="lctop">
      <span class="mstitle">CITRUS MX<span class="dot">.</span></span>
      <span class="asctag" id="bmxlevel"></span>
      <span style="flex:1"></span>
      <button class="linkish" id="bmxprev" aria-label="Previous level">&lsaquo; prev</button>
      <button class="linkish" id="bmxretry">retry</button>
      <button class="linkish" id="bmxnext" aria-label="Next level">next &rsaquo;</button>
      <button class="modalclose lcclose" id="bmxclose" aria-label="Close">&times;</button>
    </div>
    <div class="ascstats">
      <span><b id="bmxtime">0.0</b>s</span>
      <span id="bmxbest">\u2014</span>
    </div>
    <p class="lchint">${touch
      ? 'right side: gas / brake \u00b7 left side: tilt \u00b7 land on the wheels, not the head'
      : '\u2191 gas \u00b7 \u2193 brake/reverse \u00b7 \u2190\u2192 tilt \u00b7 R retry \u00b7 land on the wheels, not the head'}</p>
    ${touch ? `<div class="bmxpad bmxpad-l">
      <button id="bmxtl" aria-label="Tilt left">&#8634;</button>
      <button id="bmxtr" aria-label="Tilt right">&#8635;</button>
    </div>
    <div class="bmxpad bmxpad-r">
      <button id="bmxbrake" aria-label="Brake">&#9660;</button>
      <button id="bmxgas" aria-label="Gas">&#9650;</button>
    </div>` : ''}`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#bmxclose').addEventListener('click', closeBmx);
  $('#bmxretry').addEventListener('click', ()=>bmxLoadLevel(BMX.level));
  $('#bmxprev').addEventListener('click', ()=>bmxLoadLevel(BMX.level-1));
  $('#bmxnext').addEventListener('click', ()=>bmxLoadLevel(BMX.level+1));
  document.addEventListener('keydown', moonEsc);

  BMX.onKeyDown = e=>{
    if(e.code==='ArrowUp'||e.code==='KeyW') BMX.keys.up = true;
    if(e.code==='ArrowDown'||e.code==='KeyS') BMX.keys.down = true;
    if(e.code==='ArrowLeft'||e.code==='KeyA') BMX.keys.left = true;
    if(e.code==='ArrowRight'||e.code==='KeyD') BMX.keys.right = true;
    if(e.code==='KeyR') bmxLoadLevel(BMX.level);
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  };
  BMX.onKeyUp = e=>{
    if(e.code==='ArrowUp'||e.code==='KeyW') BMX.keys.up = false;
    if(e.code==='ArrowDown'||e.code==='KeyS') BMX.keys.down = false;
    if(e.code==='ArrowLeft'||e.code==='KeyA') BMX.keys.left = false;
    if(e.code==='ArrowRight'||e.code==='KeyD') BMX.keys.right = false;
  };
  window.addEventListener('keydown', BMX.onKeyDown);
  window.addEventListener('keyup', BMX.onKeyUp);
  if(touch){
    const hold = (id, key)=>{
      const b = $(id);
      b.addEventListener('touchstart', e=>{ e.preventDefault(); BMX.keys[key] = true; }, {passive:false});
      b.addEventListener('touchend', e=>{ e.preventDefault(); BMX.keys[key] = false; }, {passive:false});
      b.addEventListener('touchcancel', ()=>{ BMX.keys[key] = false; });
    };
    hold('#bmxgas','up'); hold('#bmxbrake','down'); hold('#bmxtl','left'); hold('#bmxtr','right');
  }
  bmxLoadLevel(startLevel);
  bmxStartLoop();
}
function bmxStartLoop(){
  const canvas = $('#bmxcanvas'), ctx = canvas.getContext('2d');
  function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  resize();
  BMX.onResize = resize;
  window.addEventListener('resize', resize);
  let last = performance.now();
  function tick(now){
    BMX.raf = requestAnimationFrame(tick);
    const dt = Math.min((now-last)/1000, 0.05); last = now;
    if(BMX.crashT > 0){
      BMX.crashT -= dt;
      if(BMX.crashT <= 0) bmxLoadLevel(BMX.level);
    }else if(BMX.doneT > 0){
      BMX.doneT -= dt;
      if(BMX.doneT <= 0){
        if(BMX.level < BMX_LEVELS.length-1) bmxLoadLevel(BMX.level+1);
        else { bmxLoadLevel(0); BMX.quip = {text:'FULL SEND COMPLETE. TOUR RESTARTS.', t:2.2}; }
        bmxSaveProgress();
      }
    }else{
      BMX.time = now - BMX.t0;
      BMX.acc += dt;
      while(BMX.acc >= BMX_C.STEP){
        BMX.acc -= BMX_C.STEP;
        const ev = bmxStep(BMX.bike, BMX.terrain, BMX.keys, BMX_C.STEP);
        if(ev.crashed){
          BMX.crashT = 1.0;
          BMX.quip = {text: pickLine(BMX_CRASH_QUIPS, Math.floor(now)), t:1.4};
          ascBeep(120, 55, 0.16, 'sine', 0.09);
          break;
        }
        if(ev.finished){
          BMX.doneT = 1.4;
          const secs = BMX.time;
          const data = store.get('lemons.bmx') || {level:0, best:{}};
          data.best = data.best || {};
          if(!data.best[BMX.level] || secs < data.best[BMX.level]) data.best[BMX.level] = Math.round(secs);
          data.level = Math.min(BMX.level+1, BMX_LEVELS.length-1);
          store.set('lemons.bmx', data);
          BMX.quip = {text:`CLEARED IN ${(secs/1000).toFixed(1)}s. EASY SQUEEZE.`, t:1.6};
          ascBeep(320, 640, 0.22, 'triangle', 0.07);
          break;
        }
      }
    }
    if(BMX.quip) BMX.quip.t -= dt;
    const t = $('#bmxtime'); if(t) t.textContent = (BMX.time/1000).toFixed(1);
    bmxRender(ctx, canvas, now/1000);
  }
  BMX.raf = requestAnimationFrame(tick);
}
function bmxSaveProgress(){
  clearTimeout(BMX.saveT);
  BMX.saveT = setTimeout(()=>{
    const data = store.get('lemons.bmx') || {best:{}};
    data.level = BMX.level;
    store.set('lemons.bmx', data);
  }, 300);
}
function closeBmx(){
  if(!BMX.open) return;
  BMX.open = false;
  cancelAnimationFrame(BMX.raf);
  clearTimeout(BMX.saveT);
  const data = store.get('lemons.bmx') || {best:{}};
  data.level = BMX.level;
  store.set('lemons.bmx', data);
  window.removeEventListener('keydown', BMX.onKeyDown);
  window.removeEventListener('keyup', BMX.onKeyUp);
  window.removeEventListener('resize', BMX.onResize);
  BMX.keys = {};
  const el = $('#bmxmodal'); if(el) el.remove();
  document.body.style.overflow = '';
}

/* secret-door wiring — delegation survives every re-render */
document.addEventListener('click', e=>{
  if(e.target.closest('#moonpeek')) openMoonScreen();
  else if(e.target.closest('#moonpct')) openLemonsweeper();
  else if(e.target.closest('.sunpeek')) openSunScreen();
  else if(e.target.closest('#sunsetsecret')) openLemoncraft();
  else if(e.target.closest('#tomorrowsecret')) openSolitaire();
  else if(e.target.closest('#nextnewsecret')) openAscent();
  else if(e.target.closest('#nextfullsecret')) openBmx();
});

/* ---------- boot ---------- */
if(state.loc) loadWeather(); else renderLocationScreen();

/* ---------- PWA service worker ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

"use strict";
/* =====================================================================
   LEMONS. — a fresh-squeezed multi-source weather blend
   ===================================================================== */

/* ---------- tiny utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const avg = arr => { const v = arr.filter(x => typeof x === 'number' && isFinite(x)); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
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
  tab: 'current',
  radar: null
};

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
function iconFor(c, size=24){
  const S = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const cloud = 'M7 17.5h9a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6 8.7 3.9 3.9 0 0 0 7 17.5z';
  if(c===0||c===1) return `<svg ${S}><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3L17 7M7 17l-1.7 1.7"/></svg>`;
  if(c===2) return `<svg ${S}><circle cx="8.5" cy="8" r="3.4"/><path d="M8.5 1.8v1.6M2.3 8h1.6M4.1 3.6l1.1 1.1M12.9 3.6l-1.1 1.1"/><path d="M10 20h7.5a3.4 3.4 0 0 0 .5-6.77A4.6 4.6 0 0 0 9.2 12 3.3 3.3 0 0 0 10 20z" fill="var(--pith)"/></svg>`;
  if(c===3) return `<svg ${S}><path d="${cloud}"/></svg>`;
  if(c===45||c===48) return `<svg ${S}><path d="M7 13.5h9a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6 4.7 3.9 3.9 0 0 0 7 13.5z"/><path d="M5 17.5h13M7.5 20.8h9"/></svg>`;
  if(c>=51&&c<=57) return `<svg ${S}><path d="${cloud}"/><path d="M9 20.4v.1M13 20.4v.1M11 22.6v.1"/></svg>`;
  if((c>=71&&c<=77)||c===85||c===86) return `<svg ${S}><path d="${cloud}"/><path d="M9 20.2l.01.01M12 22l.01.01M15 20.2l.01.01M10.5 22.6l.01.01M13.5 22.6l.01.01" stroke-width="2.4"/></svg>`;
  if(c>=95) return `<svg ${S}><path d="${cloud}"/><path d="M12 19l-1.8 3h3L11.4 25" transform="translate(0,-1.2)"/></svg>`;
  if(c>=61) return `<svg ${S}><path d="${cloud}"/><path d="M8.5 20l-.8 2.2M12 20l-.8 2.2M15.5 20l-.8 2.2"/></svg>`;
  return `<svg ${S}><path d="${cloud}"/></svg>`;
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
    + `&models=${models}&timezone=auto&forecast_days=10&wind_speed_unit=kmh`;
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
async function fetchAirQuality(lat, lon){
  const fields = [
    'us_aqi','pm2_5','pm10','ozone','nitrogen_dioxide','carbon_monoxide',
    'alder_pollen','birch_pollen','grass_pollen','mugwort_pollen','olive_pollen','ragweed_pollen'
  ];
  try{
    const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}`
      + `&hourly=${fields.join(',')}&timezone=auto&forecast_days=5`;
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
    const hourly = times.slice(idx, idx+24).map((t,i)=>{
      const j = idx+i;
      return { epochH:t, aqi:h.us_aqi?.[j] ?? null, pm25:h.pm2_5?.[j] ?? null, grass:h.grass_pollen?.[j] ?? null, ragweed:h.ragweed_pollen?.[j] ?? null };
    });
    return {
      ok:true,
      aqi:get('us_aqi'), pm25:get('pm2_5'), pm10:get('pm10'), ozone:get('ozone'),
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
  const [weatherResults, alertResult, airResult] = await Promise.all([
    Promise.allSettled([fetchOpenMeteo(lat, lon), fetchNWS(lat, lon), fetchMetNo(lat, lon), fetchBrightSky(lat, lon)]),
    fetchNWSAlerts(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:[]})),
    fetchAirQuality(lat, lon).then(v=>({ok:true, value:v})).catch(()=>({ok:false, value:{ok:false}})),
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
  const s = okSources().filter(x=>x.current && x.current.tempC!=null);
  const temps = s.map(x=>x.current.tempC);
  return {
    tempC: avg(temps),
    feelsC: avg(s.map(x=>x.current.feelsC)),
    humidity: avg(s.map(x=>x.current.humidity)),
    windKmh: avg(s.map(x=>x.current.windKmh)),
    code: pickWeatherCode(s.map(x=>x.current.code), avg(s.map(x=>x.current.precip))),
    spreadC: temps.length>1 ? Math.max(...temps)-Math.min(...temps) : 0,
    count: s.length
  };
}
function consensusHourly(hours=24){
  const start = Math.floor(Date.now()/3600000);
  const out = [];
  for(let h=start; h<start+hours; h++){
    const rows = okSources().map(s=>s.hourly?.get(h)).filter(Boolean);
    if(!rows.length) continue;
    out.push({ epochH:h, tempC:avg(rows.map(r=>r.tempC)), precip:avg(rows.map(r=>r.precip)),
      code:pickWeatherCode(rows.map(r=>r.code), avg(rows.map(r=>r.precip))), count:rows.length });
  }
  return out;
}
function consensusDaily(days=16){
  const dates = new Set();
  okSources().forEach(s=> s.daily && [...s.daily.keys()].forEach(d=>dates.add(d)));
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
  return [...dates].filter(d=>d>=todayStr).sort().slice(0,days).map(date=>{
    const rows = okSources().map(s=>s.daily?.get(date)).filter(Boolean);
    return { date, hiC:avg(rows.map(r=>r.hiC)), loC:avg(rows.map(r=>r.loC)),
      precip:avg(rows.map(r=>r.precip)), code:representativeDailyCode(date, rows), count:rows.length,
      sunrise:(rows.find(r=>r.sunrise)?.sunrise ?? null), sunset:(rows.find(r=>r.sunset)?.sunset ?? null) };
  }).filter(d=>d.hiC!=null||d.loC!=null);
}

/* =====================================================================
   RENDER
   ===================================================================== */
const T = c => c==null ? '—' : Math.round(state.unit==='F' ? cToF(c) : c);
const W = k => k==null ? '—' : Math.round(state.unit==='F' ? kmhToMph(k) : k);
const windUnit = () => state.unit==='F' ? 'mph' : 'km/h';
const degSpread = c => (state.unit==='F' ? c*9/5 : c);

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
      <div class="lowkeyrow"><button class="ghostlink" id="savedplacesbtn">saved places</button></div>
      <div id="placesPanel" class="placespanel hidden"></div>
      <p class="lochelp">Search checks Open-Meteo/GeoNames first, then OpenStreetMap for smaller US towns and ZIPs. Try things like <b>Detroit MI</b>, <b>Lakewood OH</b>, or <b>48220</b>.</p>
    </div>`;
  $('#geobtn').addEventListener('click', geolocate);
  $('#savedplacesbtn').addEventListener('click', ()=>togglePlacesPanel());
  const input = $('#citysearch');
  let deb;
  input.addEventListener('input', ()=>{ clearTimeout(deb); deb = setTimeout(()=>searchCity(input.value.trim()), 700); });
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
    try{
      const g = await fetchJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      name = g.city || g.locality || g.localityInfo?.administrative?.[0]?.name || name;
      admin = g.principalSubdivision || g.countryName || '';
    }catch(e){
      try{
        const n = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&accept-language=en`);
        name = n.address?.city || n.address?.town || n.address?.village || n.address?.hamlet || n.name || name;
        admin = n.address?.state || n.address?.country || '';
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
}
function removeSavedPlace(i){
  state.savedPlaces.splice(i,1);
  store.set('lemons.savedPlaces', state.savedPlaces);
  togglePlacesPanel(true);
}
function togglePlacesPanel(forceOpen=false){
  const panel = $('#placesPanel'); if(!panel) return;
  const shouldOpen = forceOpen || panel.classList.contains('hidden');
  if(!shouldOpen){ panel.classList.add('hidden'); return; }
  if(!state.savedPlaces.length){
    panel.innerHTML = `<p class="emptyplaces">No saved places yet. Once you pick a spot, hit <b>save</b>.</p>`;
  }else{
    panel.innerHTML = `<div class="placeshead">saved spots</div>` + state.savedPlaces.map((p,i)=>`
      <div class="placeitem">
        <button class="placego" data-place="${i}">${esc(p.name)}<span>${esc(p.admin||'')}</span></button>
        <button class="placeremove" data-remove="${i}" aria-label="Remove ${esc(p.name)}">×</button>
      </div>`).join('');
  }
  panel.classList.remove('hidden');
  panel.querySelectorAll('[data-place]').forEach(b=>b.addEventListener('click', ()=>setLocation(state.savedPlaces[+b.dataset.place])));
  panel.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click', e=>{ e.stopPropagation(); removeSavedPlace(+b.dataset.remove); }));
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
  const daily = consensusDaily(10);
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
    <section id="view-current" class="panelview" role="tabpanel"></section>
    <section id="view-hourly" class="panelview" role="tabpanel"></section>
    <section id="view-daily" class="panelview" role="tabpanel"></section>
    <section id="view-radar" class="panelview" role="tabpanel">
      <div class="radarwrap">
        <div id="map" aria-label="Precipitation radar map"></div>
        <div class="modetoggle" role="group" aria-label="Radar layer">
          <button id="modeRain" aria-pressed="true">Rain</button>
          <button id="modeSat" aria-pressed="false">Satellite</button>
        </div>
        <div class="radarui">
          <button class="playbtn" id="radarplay" aria-label="Play radar animation">
            <svg id="playicon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
          </button>
          <input class="scrub" id="radarscrub" type="range" min="0" max="0" value="0" aria-label="Radar frame">
          <span class="frametime" id="radartime">—</span>
        </div>
        <p class="radarnote">Past two hours of precipitation plus a short nowcast. Tiles by RainViewer.</p>
        <p class="mapcredit">Basemap © OpenStreetMap/CARTO · radar © RainViewer</p>
      </div>
    </section>
    <section id="view-air" class="panelview" role="tabpanel"></section>`;

  $('#changeloc').addEventListener('click', ()=>{ state.loc = null; state.tab = 'current'; renderLocationScreen(); });
  $('#saveplace').addEventListener('click', saveCurrentPlace);
  $('#openplaces').addEventListener('click', ()=>togglePlacesPanel());
  $('#shareloc').addEventListener('click', shareCurrentLocation);
  app.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click', ()=>switchTab(b.dataset.tab)));
  initSwipeNav(app);

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
  const chips = state.sources.map(s=>{
    if(s.ok===false) return `<span class="chip err">${esc(s.name)}</span>`;
    if(!s.current || s.current.tempC==null) return '';
    return `<span class="chip">${esc(s.name)} <span class="t">${T(s.current.tempC)}°</span></span>`;
  }).join('');
  const spread = degSpread(cur.spreadC||0);
  $('#view-current').innerHTML = `
    <div class="current">
      <div class="bigtemp">${T(cur.tempC)}<sup>°${state.unit}</sup></div>
      <div class="cond">${iconFor(cur.code,22)} ${codeLabel(cur.code)}</div>
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
      <p class="agree">${cur.count} sources squeezed · they agree within <b>${spread.toFixed(1)}°</b></p>
      <div class="chips">${chips}</div>
    </div>`;
}

function renderHourly(){
  const hours = consensusHourly(state.hourlyHours);
  const timeFmt = new Intl.DateTimeFormat('en-US', {hour:'numeric', timeZone: state.tz || undefined});
  const dowFmt = new Intl.DateTimeFormat('en-US', {weekday:'short', timeZone: state.tz || undefined});
  const dateFmt = new Intl.DateTimeFormat('en-US', {month:'numeric', day:'numeric', timeZone: state.tz || undefined});
  const counts = hours.map(h=>h.count);
  let lastDate = '';
  $('#view-hourly').innerHTML = `
    <div class="hourlyhead">
      <h2>${state.hourlyHours}-hour lemon table</h2>
      <div class="hrange" role="group" aria-label="Hourly forecast range">
        ${[24,48,72].map(n=>`<button data-hours="${n}" aria-pressed="${state.hourlyHours===n}">${n}h</button>`).join('')}
      </div>
    </div>
    <div class="hscroll">
      ${hours.map((h,i)=>{
        const d = new Date(h.epochH*3600000);
        const dateKey = dateFmt.format(d);
        const isNewDay = i>0 && dateKey !== lastDate;
        lastDate = dateKey;
        return `<div class="hcol${i===0?' now':''}${isNewDay?' newday':''}">
          <div class="dow">${i===0?'Now':esc(dowFmt.format(d))}</div>
          <div class="date">${esc(dateKey)}</div>
          <div class="h">${esc(timeFmt.format(d))}</div>
          ${iconFor(h.code,22)}
          <div class="t">${T(h.tempC)}°</div>
          <div class="p">${h.precip!=null&&h.precip>=5?Math.round(h.precip)+'%':''}</div>
        </div>`}).join('')}
    </div>
    <p class="blendnote">Each hour is the average of ${counts.length?Math.min(...counts):0}–${counts.length?Math.max(...counts):0} available models. Green % is chance of precipitation.</p>`;
  $('#view-hourly').querySelectorAll('[data-hours]').forEach(b=>b.addEventListener('click', ()=>{
    state.hourlyHours = +b.dataset.hours; store.set('lemons.hourlyHours', state.hourlyHours); renderHourly();
  }));
}

function renderDaily(daily){
  if(!daily.length){ $('#view-daily').innerHTML = `<div class="msg">No daily data came back.</div>`; return; }
  const allLo = Math.min(...daily.map(d=>d.loC ?? d.hiC));
  const allHi = Math.max(...daily.map(d=>d.hiC ?? d.loC));
  const span = Math.max(allHi-allLo, 1);
  const dayFmt = new Intl.DateTimeFormat('en-US', {weekday:'short'});
  const dateFmt = new Intl.DateTimeFormat('en-US', {month:'short', day:'numeric'});
  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:state.tz||undefined}).format(new Date());
  $('#view-daily').innerHTML = `
    <div class="days">
      ${daily.map(d=>{
        const dt = new Date(d.date+'T12:00:00');
        const lo = d.loC ?? d.hiC, hi = d.hiC ?? d.loC;
        const left = ((lo-allLo)/span*100).toFixed(1), width = Math.max(((hi-lo)/span*100),4).toFixed(1);
        return `<div class="dayrow">
          <span class="d">${d.date===todayStr?'Today':esc(dayFmt.format(dt))}<span class="date">${esc(dateFmt.format(dt))}</span></span>
          ${iconFor(d.code,24)}
          <span class="p">${d.precip!=null&&d.precip>=5?Math.round(d.precip)+'%':''}</span>
          <span class="range"><span class="lo">${T(lo)}°</span>
            <span class="rangebar"><i style="left:${left}%;width:${width}%"></i></span>
            <span class="hi">${T(hi)}°</span></span>
        </div>`;}).join('')}
    </div>
    <p class="blendnote">Highs and lows averaged across every source with an opinion that day. Free no-key forecast data is shown out to 16 days.</p>`;
}

function aqiLabel(v){
  if(v==null) return 'Unknown';
  if(v<=50) return 'Good';
  if(v<=100) return 'Moderate';
  if(v<=150) return 'Unhealthy for sensitive folks';
  if(v<=200) return 'Unhealthy';
  return 'Very unhealthy';
}
function pollenLabel(v){
  if(v==null) return '—';
  if(v<=1) return 'barely there';
  if(v<=15) return 'low';
  if(v<=50) return 'medium';
  return 'high';
}
function airSays(a){
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
        <div class="lemonsays"><span>Lemons says</span><p>${esc(airSays(a))}</p></div>
        <div class="hilo"></div>
        <div class="statrow airstats">
          <div class="stat"><div class="k">PM2.5</div><div class="v">${a.pm25!=null?Math.round(a.pm25):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">PM10</div><div class="v">${a.pm10!=null?Math.round(a.pm10):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">Ozone</div><div class="v">${a.ozone!=null?Math.round(a.ozone):'—'}<small> µg/m³</small></div></div>
          <div class="stat"><div class="k">NO₂</div><div class="v">${a.no2!=null?Math.round(a.no2):'—'}<small> µg/m³</small></div></div>
        </div>
      </div>

      <div class="airsection">
        <h3>Pollen count</h3>
        <div class="airrows">
          ${topPollen.length ? topPollen.map(([name,val])=>`<div class="airrowline"><span>${esc(name)}</span><b>${esc(pollenLabel(val))}</b><small>${Math.round(val)} grains/m³</small></div>`).join('') : '<p class="airnone">No pollen data for this spot right now.</p>'}
        </div>
      </div>

      <div class="airsection">
        <h3>Air through the day</h3>
        <div class="airtimeline">
          ${hourlyAir.length ? hourlyAir.map(h=>`<div class="airtimeitem"><span>${esc(timeFmt.format(new Date(h.epochH*3600000)))}</span><b>${h.aqi!=null?Math.round(h.aqi):'—'}</b><small>AQI</small></div>`).join('') : '<p class="airnone">No hourly air read came back.</p>'}
        </div>
      </div>

      <p class="blendnote">AQI and pollen use the Open-Meteo air-quality feed. Pollen can be patchy by region, so treat it as a clean heads-up, not a medical-grade read.</p>
    </div>`;
}

/* ---------- mobile swipe between sections ---------- */
function initSwipeNav(el){
  // Bind only once; renderApp can re-run when units/location update.
  if(el.dataset.swipeBound === 'true') return;
  el.dataset.swipeBound = 'true';

  const tabs = TABS;
  let startX=0, startY=0, startT=0, tracking=false;

  const ignore = target => !!target.closest(
    'button,input,select,textarea,a,.hscroll,.airtimeline,#map,.leaflet-container,.scrub'
  );

  el.addEventListener('touchstart', e=>{
    if(e.touches.length !== 1 || ignore(e.target)) return;
    tracking = true;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
  }, {passive:true});

  el.addEventListener('touchend', e=>{
    if(!tracking || !e.changedTouches.length) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const fastEnough = Date.now() - startT < 800;

    // Only treat it as tab navigation when the gesture is clearly horizontal.
    if(!fastEnough || Math.abs(dx) < 65 || Math.abs(dx) < Math.abs(dy)*1.6) return;

    const i = tabs.indexOf(state.tab);
    const next = dx < 0 ? Math.min(i+1, tabs.length-1) : Math.max(i-1, 0);
    if(next !== i) switchTab(tabs[next]);
  }, {passive:true});
}

/* ---------- tabs ---------- */
function switchTab(tab){
  state.tab = tab;
  document.querySelectorAll('nav.tabs [data-tab]').forEach(b=>b.setAttribute('aria-selected', b.dataset.tab===tab));
  document.querySelectorAll('.panelview').forEach(p=>p.classList.remove('active'));
  const view = $('#view-'+tab); if(view) view.classList.add('active');
  if(tab==='radar') initRadar();
}

/* ---------- radar (Leaflet + RainViewer) ---------- */
function initRadar(){
  if(state.radar){ state.radar.map.invalidateSize(); return; }
  if(typeof L === 'undefined'){ $('#map').innerHTML = '<p class="msg">Map library failed to load.</p>'; return; }
  const map = L.map('map', {zoomControl:true, attributionControl:true}).setView([state.loc.lat, state.loc.lon], 7);
  setTimeout(()=>map.invalidateSize(), 80);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {maxZoom:12, subdomains:'abcd', attribution:'&copy; OpenStreetMap & CARTO'}).addTo(map);
  L.circleMarker([state.loc.lat, state.loc.lon], {radius:6, color:'#23241B', weight:2, fillColor:'#F4CE3E', fillOpacity:1}).addTo(map);

  const radar = state.radar = { map, frames:[], layers:{}, idx:0, playing:false, timer:null,
    destroy(){ clearInterval(this.timer); this.map.remove(); } };

  fetchJSON('https://api.rainviewer.com/public/weather-maps.json').then(d=>{
    radar.sets = {
      rain: { frames: [...(d.radar?.past||[]), ...(d.radar?.nowcast||[])], startIdx: Math.max(0,(d.radar?.past||[]).length-1) },
      sat:  { frames: [...(d.satellite?.infrared||[])], startIdx: Math.max(0,(d.satellite?.infrared||[]).length-1) }
    };
    radar.host = d.host || 'https://tilecache.rainviewer.com';
    const scrub = $('#radarscrub');
    scrub.addEventListener('input', ()=>{ stopRadar(); showFrame(+scrub.value); });
    $('#radarplay').addEventListener('click', ()=> radar.playing ? stopRadar() : playRadar());
    $('#modeRain').addEventListener('click', ()=>setMode('rain'));
    $('#modeSat').addEventListener('click', ()=>setMode('sat'));
    setMode('rain');
  }).catch(()=>{ $('#radartime').textContent = 'radar offline'; });

  function setMode(mode){
    stopRadar();
    radar.mode = mode;
    $('#modeRain').setAttribute('aria-pressed', mode==='rain');
    $('#modeSat').setAttribute('aria-pressed', mode==='sat');
    Object.values(radar.layers).forEach(l=>l.setOpacity(0));
    radar.frames = radar.sets[mode].frames;
    const scrub = $('#radarscrub');
    if(!radar.frames.length){ $('#radartime').textContent = 'no data'; scrub.max = 0; return; }
    scrub.max = radar.frames.length-1;
    showFrame(radar.sets[mode].startIdx);
  }
  function layerFor(i){
    const f = radar.frames[i];
    if(!radar.layers[f.path]){
      const isSat = f.path.includes('satellite');
      const style = isSat ? '0/0_0' : '2/1_1'; // satellite: infrared palette · radar: universal blue w/ smoothing
      radar.layers[f.path] = L.tileLayer(`${radar.host}${f.path}/256/{z}/{x}/{y}/${style}.png`, {opacity:0, maxZoom:12, tileSize:256, crossOrigin:true, attribution:'Imagery &copy; RainViewer'});
    }
    return radar.layers[f.path];
  }
  function showFrame(i){
    radar.idx = i;
    const active = layerFor(i);
    if(!radar.map.hasLayer(active)) active.addTo(radar.map);
    active.setOpacity(radar.mode==='sat' ? 0.55 : 0.75);
    Object.values(radar.layers).forEach(l=>{ if(l!==active) l.setOpacity(0); });
    layerFor(Math.min(i+1, radar.frames.length-1)); // preload next
    $('#radarscrub').value = i;
    const t = new Date(radar.frames[i].time*1000);
    const isNowcast = radar.frames[i].time*1000 > Date.now();
    $('#radartime').textContent = (isNowcast?'+':'') + t.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }
  function playRadar(){
    radar.playing = true;
    $('#playicon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
    $('#radarplay').setAttribute('aria-label','Pause radar animation');
    radar.timer = setInterval(()=> showFrame((radar.idx+1) % radar.frames.length), 600);
  }
  function stopRadar(){
    radar.playing = false; clearInterval(radar.timer);
    $('#playicon').innerHTML = '<path d="M7 4.5v15l13-7.5z"/>';
    $('#radarplay').setAttribute('aria-label','Play radar animation');
  }
}

/* ---------- unit toggle ---------- */
function setUnit(u){
  state.unit = u; store.set('lemons.unit', u);
  $('#unitF').setAttribute('aria-pressed', u==='F');
  $('#unitC').setAttribute('aria-pressed', u==='C');
  if(state.loc && okSources().length) renderApp();
}
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
        <div class="stat"><div class="k">Next full</div><div class="v moondate">${esc(dFmt.format(moon.nextFull))}</div></div>
        <div class="stat"><div class="k">Next new</div><div class="v moondate">${esc(dFmt.format(moon.nextNew))}</div></div>
      </div>
      <div class="lemonsays moonsays"><span>Lemons says</span><p>${esc(moonFactLine(moon))}</p></div>
    </div>`;
  document.body.appendChild(el);
  document.body.style.overflow = 'hidden';
  $('#mooncloseX').addEventListener('click', closeMoonScreen);
  el.addEventListener('click', e=>{ if(e.target === el) closeMoonScreen(); });
  document.addEventListener('keydown', moonEsc);
}
function moonEsc(e){ if(e.key === 'Escape') closeMoonScreen(); }
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
        <div class="stat"><div class="k">Tomorrow</div><div class="v moondate">${delta!=null?esc(fmtDelta(delta)):'\u2014'}</div></div>
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

  const ground = new T.Mesh(new T.PlaneGeometry(100,100), new T.MeshLambertMaterial({color:0xA9BF7D}));
  ground.rotation.x = -Math.PI/2; scene.add(ground);
  const grid = new T.GridHelper(100, 50, 0x93A96B, 0x9FB575);
  grid.position.y = 0.01; scene.add(grid);

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

/* secret-door wiring — delegation survives every re-render */
document.addEventListener('click', e=>{
  if(e.target.closest('#moonpeek')) openMoonScreen();
  else if(e.target.closest('#moonpct')) openLemonsweeper();
  else if(e.target.closest('.sunpeek')) openSunScreen();
  else if(e.target.closest('#sunsetsecret')) openLemoncraft();
});

/* ---------- boot ---------- */
if(state.loc) loadWeather(); else renderLocationScreen();

/* ---------- PWA service worker ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

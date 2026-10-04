'use strict';
/* =====================================================================
   SafeCircle India: connections to outside services (APIs).
   Everything here is optional and switched on from config.js. See API.md.

   - Supabase auth           SUPABASE_URL + SUPABASE_ANON_KEY
   - Shared community reports SHARED_REPORTS: true (Supabase table "reports")
   - SOS / check-in webhook   SOS_WEBHOOK_URL (+ SOS_WEBHOOK_KEY)
   - Your own zone data       ZONES_URL (JSON)
   ===================================================================== */
const SCApi = (() => {
  const CFG = window.SC_CONFIG || {};
  const VERSION = '3.0.0';
  const hasSupabase = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
  const flags = {
    supabase:hasSupabase,
    sharedReports:hasSupabase && !!CFG.SHARED_REPORTS,
    webhook:!!CFG.SOS_WEBHOOK_URL,
    zones:!!CFG.ZONES_URL
  };

  /* ---------- Supabase client (loaded only when configured) ---------- */
  let sbPromise = null;
  function getSupabase(){
    if(!hasSupabase) return Promise.resolve(null);
    if(!sbPromise){
      sbPromise = new Promise(resolve => {
        const make = () => resolve(window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null);
        if(window.supabase) return make();
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        s.onload = make;
        s.onerror = () => { sbPromise = null; resolve(null); };
        document.head.appendChild(s);
      });
    }
    return sbPromise;
  }
  async function signedIn(){
    const sb = await getSupabase();
    if(!sb) return false;
    try{ const {data} = await sb.auth.getSession(); return !!(data && data.session); }catch(e){ return false; }
  }

  /* ---------- Shared community reports ---------- */
  const toRow = r => ({id:r.id, zone_id:r.zoneId, sev:r.sev, text:r.text, cats:r.cats || [], tod:r.tod || null, created_at:new Date(r.ts).toISOString()});
  const fromRow = row => ({
    id:String(row.id), zoneId:String(row.zone_id), sev:row.sev, text:String(row.text || ''),
    cats:Array.isArray(row.cats) ? row.cats : [], tod:row.tod || '', ts:Date.parse(row.created_at),
    verified:true, mine:false, shared:true
  });
  async function pushReport(r){
    if(!flags.sharedReports) return {ok:false, skipped:true};
    const sb = await getSupabase();
    if(!sb || !(await signedIn())) return {ok:false, error:'not signed in'};
    const {error} = await sb.from('reports').insert(toRow(r));
    return {ok:!error, error:error && error.message};
  }
  async function pullReports(days = 180){
    if(!flags.sharedReports) return null;
    const sb = await getSupabase();
    if(!sb) return null;
    const since = new Date(Date.now() - days*86400000).toISOString();
    const {data, error} = await sb.from('reports')
      .select('id,zone_id,sev,text,cats,tod,created_at')
      .gte('created_at', since).order('created_at', {ascending:false}).limit(500);
    if(error) throw new Error(error.message);
    return (data || []).map(fromRow).filter(r => ['green', 'yellow', 'red'].includes(r.sev) && Number.isFinite(r.ts));
  }
  async function deleteReport(id){
    if(!flags.sharedReports) return {ok:false, skipped:true};
    const sb = await getSupabase();
    if(!sb) return {ok:false};
    const {error} = await sb.from('reports').delete().eq('id', id);
    return {ok:!error, error:error && error.message};
  }

  /* ---------- SOS / check-in webhook ----------
     Sent as text/plain JSON so browsers don't need a CORS preflight, and with
     sendBeacon so it still goes out if the page is closed straight after. */
  function postEvent(type, data = {}){
    if(!flags.webhook) return false;
    const body = JSON.stringify({type, app:'safecircle-india', version:VERSION, key:CFG.SOS_WEBHOOK_KEY || undefined, sentAt:new Date().toISOString(), ...data});
    try{
      if(navigator.sendBeacon && navigator.sendBeacon(CFG.SOS_WEBHOOK_URL, new Blob([body], {type:'text/plain;charset=UTF-8'}))) return true;
    }catch(e){}
    fetch(CFG.SOS_WEBHOOK_URL, {method:'POST', mode:'no-cors', keepalive:true, headers:{'Content-Type':'text/plain;charset=UTF-8'}, body}).catch(() => {});
    return true;
  }

  /* ---------- Your own zone data ---------- */
  function validZone(z){
    return z && typeof z.id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(z.id) && typeof z.name === 'string' && z.name.length < 80 &&
      ['red', 'yellow', 'green'].includes(z.level) && Number.isFinite(+z.lat) && Number.isFinite(+z.lng) &&
      Math.abs(z.lat) <= 90 && Math.abs(z.lng) <= 180;
  }
  async function fetchZones(){
    if(!flags.zones) return null;
    const data = await fetchJSON(CFG.ZONES_URL, {timeout:10000});
    const list = (Array.isArray(data) ? data : (data && data.zones) || []).filter(validZone)
      .map(z => ({id:z.id, name:z.name, level:z.level, lat:+z.lat, lng:+z.lng, reason:String(z.reason || ''), source:String(z.source || '')}));
    return list.length ? list : null;
  }

  return {flags, VERSION, getSupabase, signedIn, pushReport, pullReports, deleteReport, postEvent, fetchZones, validZone};
})();

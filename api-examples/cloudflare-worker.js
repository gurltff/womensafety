/**
 * SafeCircle alert server: a Cloudflare Worker (free plan is enough).
 *
 * The app sends SOS and check-in events here (SOS_WEBHOOK_URL in config.js).
 * This server:
 *   - posts every alert to a Telegram chat (free; e.g. a family group)
 *   - optionally texts emergency contacts by SMS through Twilio
 *   - runs a "dead man's switch" for check-ins: if the app never reports
 *     "I'm safe", it alerts anyway, even if the phone is locked, off or offline.
 *
 * Secrets live here on the server, never in the app. Setup: API.md section 3.
 *
 * Settings (set with `npx wrangler secret put NAME`):
 *   WEBHOOK_KEY          must match SOS_WEBHOOK_KEY in config.js
 *   TELEGRAM_BOT_TOKEN   from @BotFather
 *   TELEGRAM_CHAT_ID     the chat or group that receives alerts
 *   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM   (optional) SMS
 *   ALLOWED_SMS_TO       (optional) comma-separated numbers allowed to receive SMS,
 *                        e.g. +919812345678,+919898989898. Nothing else is ever texted.
 * Bindings (wrangler.toml): KV namespace CHECKINS, cron trigger "* * * * *".
 */

const GRACE_MS = 5 * 60 * 1000; // how long after a missed check-in before the server alerts
const MAX_BODY = 20000;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return new Response('SafeCircle alert server is running.', { headers: cors() });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'too large' }, 413);
    let ev;
    try { ev = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
    if (!env.WEBHOOK_KEY || ev.key !== env.WEBHOOK_KEY) return json({ error: 'bad key' }, 401);
    if (typeof ev.type !== 'string') return json({ error: 'missing type' }, 400);

    const key = 'checkin:' + String((ev.user && ev.user.phone) || 'unknown').replace(/[^\d+]/g, '');
    switch (ev.type) {
      case 'test':
        await alert(env, `✅ SafeCircle test from ${who(ev)}: the alert server works.`);
        break;
      case 'sos.started':
        await alert(env, sosText(ev), smsTargets(env, ev));
        break;
      case 'sos.location':
        await alert(env, `📍 ${who(ev)} moved. Live location: ${link(ev)}${ev.address ? `\nNear: ${clip(ev.address, 120)}` : ''}`);
        break;
      case 'sos.ended':
        await alert(env, `✅ ${who(ev)} ended the SOS alert and says they are safe.`, smsTargets(env, ev));
        break;
      case 'checkin.started':
      case 'checkin.extended':
        if (!validCheckin(ev)) return json({ error: 'bad checkin' }, 400);
        if (env.CHECKINS) await env.CHECKINS.put(key, JSON.stringify(ev), { expirationTtl: 60 * 60 * 24 });
        if (ev.type === 'checkin.started') {
          await alert(env, `🕒 ${who(ev)} started a check-in${note(ev)}. They should confirm they're safe by ${time(ev.checkin.endAt)}. Location: ${link(ev)}`);
        }
        break;
      case 'checkin.ended':
      case 'checkin.cancelled':
        if (env.CHECKINS) await env.CHECKINS.delete(key);
        if (ev.type === 'checkin.ended') await alert(env, `✅ ${who(ev)} checked in safely${note(ev)}.`);
        break;
      case 'checkin.missed':
        if (env.CHECKINS) await env.CHECKINS.delete(key);
        await alert(env, `⚠️ ${who(ev)} MISSED their check-in${note(ev)}. Call them now. Last location: ${link(ev)}`, smsTargets(env, ev));
        break;
      default:
        return json({ error: 'unknown type' }, 400);
    }
    return json({ ok: true });
  },

  /** Runs every minute: alerts for check-ins whose time ran out without an "I'm safe". */
  async scheduled(_event, env) {
    if (!env.CHECKINS) return;
    const { keys } = await env.CHECKINS.list({ prefix: 'checkin:' });
    for (const k of keys) {
      const ev = JSON.parse((await env.CHECKINS.get(k.name)) || 'null');
      if (!ev || !validCheckin(ev)) continue;
      if (Date.now() > Date.parse(ev.checkin.endAt) + GRACE_MS) {
        await env.CHECKINS.delete(k.name);
        await alert(env,
          `⚠️ ${who(ev)} hasn't checked in. Their timer${note(ev)} ended at ${time(ev.checkin.endAt)} and the app never confirmed they're safe ` +
          `(their phone may be off or locked). Call them now. Last known location: ${link(ev)}`,
          smsTargets(env, ev));
      }
    }
  },
};

/* ---------- messages ---------- */
function sosText(ev) {
  const lines = [`🆘 SOS from ${who(ev)}${ev.user && ev.user.phone ? ` (${ev.user.phone})` : ''}`];
  if (ev.reason) lines.push(clip(ev.reason, 160));
  lines.push(`📍 ${link(ev)}${ev.location && ev.location.accuracy ? ` (±${Math.round(ev.location.accuracy)} m)` : ''}`);
  if (ev.address) lines.push(`Near: ${clip(ev.address, 120)}`);
  if (Number.isFinite(ev.battery)) lines.push(`🔋 ${ev.battery}%`);
  if (ev.medical && ev.medical.blood) lines.push(`Blood group: ${clip(ev.medical.blood, 4)}`);
  lines.push('If you can, call them. In India, police emergency is 112.');
  return lines.join('\n');
}
const who = (ev) => clip((ev.user && ev.user.name) || 'A SafeCircle user', 60);
const note = (ev) => (ev.checkin && ev.checkin.note ? ` (${clip(ev.checkin.note, 80)})` : '');
const link = (ev) => {
  const l = ev.location;
  return l && Number.isFinite(l.lat) && Number.isFinite(l.lng) ? `https://maps.google.com/?q=${l.lat.toFixed(6)},${l.lng.toFixed(6)}` : 'unknown';
};
const time = (iso) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const clip = (s, n = 200) => String(s == null ? '' : s).slice(0, n);
const validCheckin = (ev) => ev.checkin && !Number.isNaN(Date.parse(ev.checkin.endAt));

/* ---------- delivery ---------- */
/** Only numbers you allow-listed AND the user listed as contacts, so a leaked key can't text strangers. */
function smsTargets(env, ev) {
  if (!env.ALLOWED_SMS_TO || !Array.isArray(ev.contacts)) return [];
  const allowed = new Set(env.ALLOWED_SMS_TO.split(',').map((s) => s.trim()).filter(Boolean));
  return [...new Set(ev.contacts.map((c) => String(c.phone || '').replace(/[^\d+]/g, '')).filter((p) => allowed.has(p)))];
}
async function alert(env, text, smsTo = []) {
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    }));
  }
  if (env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
    for (const to of smsTo) {
      jobs.push(fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text.slice(0, 1500) }),
      }));
    }
  }
  const results = await Promise.allSettled(jobs);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.log('delivery failed', String(r.reason)));
}

const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...cors() } });

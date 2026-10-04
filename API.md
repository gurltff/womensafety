# Adding APIs to SafeCircle

SafeCircle is a static website: HTML, CSS and JavaScript running in the browser, with no server of its own. An API is another service the app talks to over the internet. This guide covers:

1. [How APIs fit into this app](#1-how-apis-fit-into-this-app)
2. [Shared community reports (Supabase)](#2-shared-community-reports-supabase)
3. [Automatic SOS and check-in alerts (your own alert server)](#3-automatic-sos-and-check-in-alerts)
4. [Your own zone data (JSON API)](#4-your-own-zone-data)
5. [Adding any other API](#5-adding-any-other-api)

Everything is switched on from **`config.js`**. Each connection you turn on shows as **ON** under **Profile → Connections (APIs)**.

## 1. How APIs fit into this app

```
            ┌───────────────────────────── browser (the app) ─────────────────────────────┐
            │ config.js → api.js → app.js / tools.js                                       │
            └──────┬───────────────┬────────────────┬───────────────────┬─────────────────┘
                   │               │                │                   │
   Free public APIs (no key)   Supabase         Your alert server     Your zones JSON
   map tiles, place search,    sign-in codes,   (Cloudflare Worker)   ZONES_URL
   routing, police/hospitals   shared reports   → Telegram, SMS
```

**Public vs secret keys: the one rule that matters.** Anything in `config.js` or any `.js` file can be read by anyone who opens the site. So:

| Safe in `config.js` (public) | Never in `config.js` (secret) |
| --- | --- |
| Supabase **anon** key | Supabase **service_role** key |
| Your webhook URL | Twilio auth token |
| A zones JSON URL | Telegram bot token |
| Browser-restricted map keys | Any key that costs money or sends messages |

Secret keys go on a server. The alert server in `api-examples/` is that server: the app sends it an event, and the server, which holds the secrets, sends the Telegram message or SMS.

### APIs already built in (no key needed)

| What | Service | Where in the code |
| --- | --- | --- |
| Map tiles | CARTO, Esri, OpenStreetMap | `buildMap()` in `app.js` |
| Place search, address lookup | OpenStreetMap Nominatim | `attachPlaceSearch()`, `maybeReverseGeocode()` in `app.js` |
| Road routes | OSRM demo server | `checkRoute()` in `app.js` |
| Police, hospitals, pharmacies | OpenStreetMap Overpass | `findNearbyHelp()` in `tools.js` |

These are free but rate-limited, and meant for light use. If the app gets real traffic, swap the URL in that function for a paid provider (Mapbox, Google Maps Platform, MapmyIndia and others). Use a key restricted to your domain, or route the calls through your own server.

## 2. Shared community reports (Supabase)

By default, reports stay on the phone that made them. With this switched on, every verified user's reports go into one database table, so everyone sees everyone's reports on the map, the feed and the Insights charts.

**You need:** a Supabase project with sign-in already set up ([SETUP.md](SETUP.md)). Only verified users can post.

1. In Supabase, open **SQL Editor → New query**, paste the contents of [`api-examples/supabase-reports.sql`](api-examples/supabase-reports.sql), and click **Run**. This creates a `reports` table with Row Level Security:
   - anyone using the app can read reports
   - only signed-in users can add them, and only as themselves
   - users can delete only their own
2. In `config.js`, set `SHARED_REPORTS: true`.
3. Bump `CACHE` in `sw.js` (for example `safecircle-v3.0.1`), commit and push.

**Check it worked:** sign in on two devices and add a report on one. It appears on the other's **Reports** tab, marked *community*, within a minute.

Reports don't show names, but each row stores a random user ID, so someone reading the database could tell that two reports came from the same account. For a public launch, add moderation (for example, a `hidden` column you can set from the Supabase dashboard).

## 3. Automatic SOS and check-in alerts

On its own, a web app can't send a text message. It can only open the SMS app for you to press send. And if the phone is locked, the browser may pause the check-in timer.

An alert server fixes both. The app sends it an event the moment something happens, and the server messages your people itself.

**What you get:**
- 🆘 an SOS alert to a Telegram group (and optionally by SMS) with name, live map link, address, battery and blood group
- 📍 location updates every minute while SOS is active
- 🕒 the **dead man's switch**: when a check-in starts, the server starts its own timer. If the app never says "I'm safe", because the phone died, was taken or was locked, the server alerts anyway, 5 minutes after the deadline.

### Deploy the ready-made server (about 20 minutes, free)

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, [Node.js](https://nodejs.org), and Telegram.

**a) Make a Telegram bot and a group**
1. In Telegram, message **@BotFather**, send `/newbot`, and follow the steps. Copy the **token** it gives you.
2. Create a group (for example "Priya – SafeCircle") with the people who should get alerts, and add your bot to it.
3. Send any message in the group, then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser. Find `"chat":{"id":-100…}`. That number, including the minus sign, is your **chat ID**.

**b) Deploy the worker**
```bash
cd api-examples
npx wrangler login
npx wrangler kv namespace create CHECKINS     # paste the id it prints into wrangler.toml
npx wrangler secret put WEBHOOK_KEY            # make up a long random password
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy                            # prints your URL: https://safecircle-alerts.<you>.workers.dev
```

**c) Optional: SMS through Twilio**
```bash
npx wrangler secret put TWILIO_SID
npx wrangler secret put TWILIO_TOKEN
npx wrangler secret put TWILIO_FROM            # your Twilio number, e.g. +15551234567
npx wrangler secret put ALLOWED_SMS_TO         # e.g. +919812345678,+919898989898
```
The server only texts numbers that are in `ALLOWED_SMS_TO` **and** in the user's emergency contacts, so a leaked webhook key can't be used to text strangers. Commercial SMS to Indian numbers needs DLT registration (a TRAI rule), which your SMS provider handles. Telegram needs none of this.

**d) Connect the app.** In `config.js`:
```js
SOS_WEBHOOK_URL: 'https://safecircle-alerts.<you>.workers.dev',
SOS_WEBHOOK_KEY: 'the same password you set as WEBHOOK_KEY',
```
Bump `CACHE` in `sw.js`, push, open the app, and go to **Profile → Connections → Send a test alert**. A ✅ message should appear in your Telegram group.

### Events the app sends

Every event is a `POST` with a JSON body (sent as `text/plain`, so browsers skip the CORS preflight):

```json
{
  "type": "sos.started",
  "app": "safecircle-india", "version": "3.0.0", "key": "your-webhook-key",
  "sentAt": "2026-10-04T15:42:07.120Z",
  "user": {"name": "Priya Sharma", "phone": "+919876543210"},
  "contacts": [{"name": "Didi", "phone": "+919123456789", "relation": "Sister"}],
  "location": {"lat": 28.6315, "lng": 77.2167, "accuracy": 18, "approx": false, "mapsUrl": "https://maps.google.com/?q=28.631500,77.216700"},
  "address": "Connaught Place, New Delhi, Delhi",
  "battery": 34,
  "reason": null,
  "medical": {"blood": "B+", "allergies": "", "notes": ""},
  "message": "I need help. Please call me…\n📍 https://maps.google.com/?q=…"
}
```

| `type` | When |
| --- | --- |
| `test` | Profile → Send a test alert |
| `sos.started` | SOS screen opens |
| `sos.location` | During SOS: every minute, or after moving 150 m |
| `sos.ended` | "I'm safe now" on the SOS screen |
| `checkin.started` / `checkin.extended` | Timer started / +10 min (includes `checkin.endAt`) |
| `checkin.ended` | "I'm safe" tapped |
| `checkin.cancelled` | Timer stopped without "I'm safe" (for example, the user pressed "I need help", which also sends `sos.started`) |
| `checkin.missed` | The 60-second "Are you safe?" countdown ran out in the app |

You don't have to use Cloudflare. Any server that accepts a POST works: Supabase Edge Functions, Netlify or Vercel functions, n8n, Make, Zapier, or your own backend. Read the body as text, then `JSON.parse` it, and check `key`.

## 4. Your own zone data

The map ships with 13 NCRB metro cities. To add districts, neighbourhoods or newer data without touching the code, publish a JSON file and point the app at it.

1. Copy [`api-examples/zones.example.json`](api-examples/zones.example.json) and edit it. Each zone needs:

   | Field | Example | Notes |
   | --- | --- | --- |
   | `id` | `"noida"` | letters, numbers, `-` or `_` |
   | `name` | `"Noida"` | |
   | `level` | `"red"` | `red`, `yellow` or `green`: your public baseline |
   | `lat`, `lng` | `28.5355`, `77.391` | |
   | `reason` | `"Why this level…"` | shown in the city sheet |
   | `source` | `"NCRB 2023, table 3C.1"` | optional; shown as the source note |

2. Host it anywhere that serves JSON with CORS: the same GitHub Pages repo (`data/zones.json`), a gist, Supabase Storage, or your own API endpoint.
3. In `config.js`: `ZONES_URL: 'data/zones.json'` (a relative path works when it's in the same repo).

The app fetches the file on start, skips invalid entries, and caches the last good copy so it also works offline. Please only publish levels you can source.

## 5. Adding any other API

The pattern is the same for any service:

1. **Config:** add a setting to `config.js`, for example `MY_API_URL: ''`.
2. **Call it:** add a function to `api.js`. `fetchJSON()` (in `app.js`) already handles timeouts:

   ```js
   async function fetchSomething(){
     if(!CFG.MY_API_URL) return null;
     return fetchJSON(CFG.MY_API_URL + '/something', {timeout:10000});
   }
   ```
   Then add it to the `return {…}` list at the bottom of `api.js`.
3. **Use it:** call `SCApi.fetchSomething()` from `app.js` and render the result. Insert any text from an API with `textContent` or `escapeHtml()`, never raw `innerHTML`.
4. **Offline:** if the app should still work without internet, cache the last result in `localStorage`, like `applyZones()` does.
5. **Secrets:** if the API needs a secret key, don't call it from the browser. Add a route to your server (like the worker in section 3) that holds the key, and call that route instead.

### Example: India's open government data (data.gov.in)

[data.gov.in](https://data.gov.in) publishes NCRB tables as datasets with an API. Register for a free API key, open the dataset you want, and copy its **resource ID**. Requests look like this:

```
https://api.data.gov.in/resource/<RESOURCE_ID>?api-key=<YOUR_KEY>&format=json&limit=100
```

That key only reads public data, but it identifies you and is rate-limited, so for a public site fetch it from your server (or a scheduled script that writes `zones.json`, see section 4) rather than from every visitor's browser.

### After any change

- Bump `CACHE` in `sw.js`, so installed copies download the new files.
- Check **Profile → Connections**.
- Test with the browser's developer tools open (**Network** tab) to see each request and its response.

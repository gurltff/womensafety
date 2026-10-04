/* SafeCircle India configuration: where you plug in APIs.
   Everything is optional. Leave a value empty and that feature stays off.
   Full step-by-step guide: API.md (and SETUP.md for Supabase sign-in).

   Only put PUBLIC values in this file: anyone can read it in the browser.
   Secret keys (Twilio, Telegram bot tokens, Supabase service_role) belong
   on a server, such as the example in api-examples/. */
window.SC_CONFIG = {
  /* Supabase: real email + SMS verification codes (SETUP.md) */
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  /* Share community reports between all users through a Supabase table (API.md §2) */
  SHARED_REPORTS: false,

  /* Your alert server: receives SOS and check-in events as JSON and can text or
     Telegram your contacts automatically, even if the phone is locked (API.md §3) */
  SOS_WEBHOOK_URL: '',
  SOS_WEBHOOK_KEY: '',

  /* Load city risk zones from your own API or JSON file instead of the built-in list (API.md §4) */
  ZONES_URL: ''
};

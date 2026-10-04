# Setting up real email and SMS verification

By default SafeCircle runs in **demo mode**: the sign-up screen shows the 6-digit code instead of sending it. That's fine for trying the app. To send real codes, connect a free [Supabase](https://supabase.com) project. It takes about 15 minutes for email; SMS takes longer because it needs an SMS provider.

## 1. Create a Supabase project

1. Sign up at supabase.com and click **New project**.
2. Pick a name, a database password and a region close to your users (for India, **Mumbai** / `ap-south-1`).
3. Wait for the project to finish setting up.

## 2. Email codes

Supabase sends a "magic link" email by default. SafeCircle needs a 6-digit code instead:

1. Go to **Authentication → Providers → Email** and make sure it is enabled.
2. In **Authentication**, open the email templates (called **Email Templates** or **Emails → Templates** depending on your dashboard version) and select **Magic Link**.
3. Replace the body with something that includes `{{ .Token }}`, for example:

   ```html
   <h2>Your SafeCircle code</h2>
   <p>Enter this code to verify your email:</p>
   <p style="font-size:28px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
   <p>It expires in 10 minutes. If you didn't request it, ignore this email.</p>
   ```

4. Save. Supabase's built-in email service is rate-limited and meant for testing. For real users, add your own SMTP server in the dashboard's **SMTP Settings** (under Authentication or Project Settings). Resend, Brevo, Amazon SES and others work.

## 3. SMS codes

1. Go to **Authentication → Providers → Phone** and enable it.
2. Choose an SMS provider (Twilio, Twilio Verify, MessageBird, Vonage or Textlocal) and paste its credentials.
3. **India only:** commercial SMS to Indian numbers must be registered on a DLT platform (sender ID and message template), as required by TRAI. Your SMS provider will guide you through this. Without it, messages to Indian numbers may be blocked.

SafeCircle verifies the email first, then adds the phone number to the same account (`updateUser` → `verifyOtp` with type `phone_change`).

## 4. Allow your site's address

Go to **Authentication → URL Configuration** and set **Site URL** to where the app is hosted, for example `https://<your-username>.github.io/<repo-name>/`. Add `http://localhost:8000` under **Redirect URLs** if you test locally.

## 5. Add your keys to `config.js`

In **Project Settings** (the **API** / **API Keys** pages), copy the **Project URL** and the **anon public** key into `config.js`:

```js
window.SC_CONFIG = {
  SUPABASE_URL: 'https://abcdefghijkl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

The anon key is designed to be public, so it is safe to commit. **Never** put the `service_role` key in this file.

Commit, push, and bump `CACHE` in `sw.js` (for example `safecircle-v2.0.1`) so installed copies pick up the new config. The demo banner disappears and real codes are sent.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Email arrives with a link, not a code | The Magic Link template doesn't include `{{ .Token }}` (step 2) |
| "Email rate limit exceeded" | Built-in email is limited to a few per hour. Set up custom SMTP |
| SMS never arrives in India | Check DLT registration with your SMS provider |
| "Phone provider not enabled" | Enable the Phone provider (step 3) |
| Still in demo mode after adding keys | Hard-refresh, or bump `CACHE` in `sw.js` so the service worker serves the new `config.js` |

# Bonafide: trust-first dating app (working MVP)

Web app for serious relationships. Mobile-first, runs in any phone or desktop browser.
Pure Python 3 standard library plus SQLite: nothing to install.

## Run it

```
python3 server.py
```

Open http://localhost:8000 . To use it from a phone on the same Wi-Fi:
`HOST=0.0.0.0 python3 server.py` and open `http://<your-computer-ip>:8000`
(camera and location need HTTPS on phones, see "Going live").

Settings (environment variables): `PORT`, `HOST`, `BONAFIDE_DB` (database path),
`VERIFY_MODE` (`demo` by default), `SECURE_COOKIE=1` (when behind HTTPS).

## What works

- Signup / login (18+ enforced, passwords hashed with PBKDF2, 30-day sessions)
- Verification gate: nobody can browse or chat until selfie + ID steps are done
- Discover: only verified, well-rated, non-suspended members of the other gender
- Women message first: men cannot start a chat, they can reply once she says hello
- Scam alert: messages about money, UPI, OTP, bank details, loans etc. show the receiver a warning with a one-tap Report and block; each flagged message lowers the sender's trust score
- Trust score (0 to 100): verified, photo and bio raise it; reports and flagged messages lower it
- Report and block: reporting also blocks; 3 reports from different people suspend the account automatically
- Safe Date: venue, trusted contact, check-in timer, live location (while the page is open), "I am safe", SOS, call 112. The trusted contact gets a link (no account needed) showing status and last location, auto-refreshing
- Profile with photo (resized on the phone before upload), bio, intent

## What is still demo (do before real users)

1. **Verification is demo mode.** `verify_step()` in `server.py` auto-approves. Replace it with a real provider (DigiLocker / a KYC vendor with face match and liveness) and keep `VERIFY_MODE` off `demo`.
2. **Safe Date alerts are link-based.** The contact sees an overdue or SOS state when they open the link. To push SMS/WhatsApp automatically, add a provider and send when a check-in goes overdue or SOS is pressed.
3. **HTTPS is required** for camera and location on phones. Put it behind a reverse proxy (Caddy or nginx) with a certificate, and set `SECURE_COOKIE=1`.
4. **Moderation.** Reports are stored in the `reports` table; add an admin view and a review process.
5. **Legal.** Privacy policy and terms, consent for ID data, and compliance with India's DPDP Act. Take legal advice before launch.
6. **Scale.** SQLite is fine for early testing. Move to PostgreSQL, add backups and rate limiting at the proxy before real traffic.
7. **Phone app.** This is a web app. It can be wrapped for Play Store / App Store (for example with Capacitor) after the above is done.

## Files

- `server.py`: server, database, all rules
- `static/index.html`, `static/style.css`, `static/app.js`: the app screens

# WhisperHall — Release Candidate

This release replaces the earlier prototype's inconsistent relay packet formats, incomplete history loading, weak private-room passphrase checks, and misleading anti-capture claims.

## Project structure

```text
whisperhall-release/
├── public/
│   └── index.html
├── backend/
│   ├── src/server.js
│   ├── package.json
│   └── .env.example
└── README.md
```

## Run locally

Requirements: Node.js 20 or newer.

1. Open a terminal in `backend/`.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. For local development, set `NODE_ENV=development` and leave `ALLOWED_ORIGINS` blank.
5. Run `npm start`.
6. Serve `public/index.html` from a local static server (for example, `npx serve public`) and enter `ws://localhost:8080` in the profile dialog.

The browser Web Crypto API requires a secure context: HTTPS in deployment, or localhost during development.

## Deploy

### Frontend
Deploy the contents of `public/` to a static host that supports HTTPS (Netlify, Cloudflare Pages, Vercel static hosting, or a conventional web host). Set the site's final HTTPS origin in the backend's `ALLOWED_ORIGINS`.

### Backend
Deploy `backend/` to a Node.js host that supports persistent WebSocket connections. Use Node 20+, run `npm install` during build, and `npm start` as the start command. Set:
- `NODE_ENV=production`
- `PORT` to the host-provided port (if required)
- `ALLOWED_ORIGINS=https://your-exact-site-domain`

The public site must connect using the backend's `wss://` URL. Do not use `ws://` from an HTTPS website.

Check `https://your-backend-domain/health` after deployment. It should return JSON with `"status":"ok"`.

## Important limitations before public launch

This is a **release-candidate prototype, not a fully production-hardened social platform**.

- The relay stores public messages and encrypted private envelopes in process memory until their TTL expires. A restart clears them. There is no database or guaranteed delivery.
- The relay has no accounts, authentication, verified school membership, moderation, blocking, reporting, admin console, or abuse response workflow. Display names and school names are user supplied.
- Private-room encryption uses Web Crypto PBKDF2-HMAC-SHA-256 (310,000 iterations) and AES-256-GCM with a fresh random salt and 96-bit IV per message. The server cannot decrypt the message body, but sees metadata. This code has not undergone an independent cryptographic security audit.
- A room name is not an access-control mechanism. Anyone who knows the room name can attempt to join; confidentiality depends on the shared passphrase. Use a unique, high-entropy passphrase and do not reuse passwords.
- The client-side "hide chat" button only blurs the page. No browser app can reliably block OS screenshots, screen recording, cameras, developer tools, or copying. Do not advertise this as screenshot protection or leak-proof security.
- Rate limiting is per WebSocket connection and in-memory. A production service should add IP/account-level controls, persistent abuse prevention, monitoring, logging policy, and a reverse proxy with TLS.
- The frontend currently uses Tailwind's CDN for convenience. For a commercial or high-traffic release, install Tailwind as a build dependency and ship compiled CSS.
- Add a privacy policy, terms, age-appropriate safeguards, contact details, and a clear data-retention statement before inviting real users.

## Pre-launch checklist

- [ ] Configure exact production origins; never leave the production allowlist empty.
- [ ] Deploy backend and frontend over HTTPS/WSS.
- [ ] Test two separate browsers/devices in public and private rooms.
- [ ] Verify TTL expiry, reconnect, wrong passphrase, and relay restart behavior.
- [ ] Add authentication, moderation, abuse reporting, and operational monitoring before opening it to a broad audience.
- [ ] Arrange an independent security review before describing the vault as secure or end-to-end encrypted in marketing.

## Main fixes in this release

- Aligned client and backend message/envelope schemas.
- Added public and private room history replay on join.
- Added relay-side room membership checks before accepting messages.
- Server derives display identity from the WebSocket profile rather than trusting identity fields on every message.
- Added strict private envelope validation, passphrase minimum length, fresh per-message salt/IV, and stronger PBKDF2 work factor.
- Fixed profile validation, duplicate-message handling, expiry handling, reply rendering, room switching, connection status and user-facing errors.
- Removed misleading claims that keyboard shortcuts can reliably prevent capture.
- Replaced unsafe HTML interpolation in message bodies with `textContent` rendering.

# Invitation links

The browser shares site registration links as `https://your-domain.example/#invite=TOKEN` and room links as `https://your-domain.example/#join=TOKEN`. The origin always comes from the running app; no deployment domain is hardcoded. Fragments are not sent in HTTP requests or Referer headers. Treat the full link as a bearer credential and share it only with the intended recipient.

`public/invite-links.mjs` performs no fetch, registration, login, or membership changes. Construct `createInviteLinks()` before `loadSession()` or other application requests. It immediately removes recognized invitation fragments with `history.replaceState`, then retains valid tokens in this tab's `sessionStorage`, with an in-memory fallback if browser storage is blocked. The server currently makes invitations single use and valid for 24 hours; client retention is also bounded to 24 hours and does not replace server expiration checks.

Frontend integration:

- `createInviteLink('site' | 'room', token)` returns the full link for display/copy.
- `createInviteLinks()` returns `{capture, get, clear}`. `get('site')` / `get('room')` returns a token or `null` without consuming it. Call `capture()` on `hashchange` to handle another link opened in the same tab.
- A pending site invite selects registration, prefills the hidden `inviteToken` input, and explains that a signup invitation was received. Submit the existing `/api/register` POST; clear the site token only after success or explicit discard. Keep the manual bootstrap token input available for a fresh installation without an invitation link.
- A pending room invite survives login or registration. After authentication, prefill the hidden join input and open a confirmation dialog. Only the user's “Join” action submits `/api/rooms/join`; clear the room token after successful participation or explicit discard. Never submit a join POST just because a link was opened.
- A room invitation does not authorize creation of a site account: new members also need a signup invitation. Site invitations do not grant room membership.
- Preserve pending links when showing an authentication error. Remove the sidebar join-code menu; the confirmation dialog remains accessible from a pending room link.

Malformed or ambiguous fragments (duplicate tokens, both invitation types, extra parameters) are scrubbed without overriding a previously pending valid invitation. Unsupported origins and tokens over 200 characters are rejected. The UI must render all link values as text, never HTML. No token should be added to query parameters, analytics, or application logs.

Focused verification: `node --test apps/community/test/invite-links.test.mjs`.

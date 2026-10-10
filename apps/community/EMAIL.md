# Email task channel

An operator can connect the existing administrator mailbox to the same agent and
tools used in web conversations. The feature is disabled in a fresh installation.
Mail remains in the inbox even when it is not eligible to run a task. Existing
provider-side forwarding is independent of the task channel.

In **Mail → Email tasks**, enable the channel and map each permitted sender address
to an existing application user. Only administrators can change these mappings.
Inviting somebody to the app does not register an email address automatically.
The mapped user's existing permissions apply: member requests do not acquire the
administrator's private mail/calendar access. The shared browser retains the same
access boundaries as web conversations.

The mailbox bridge needs authenticated list, message, original MIME (`raw=1`), and
reply operations. Keep `COMMUNITY_MAIL_URL` and `COMMUNITY_MAIL_TOKEN` in the
server's private configuration. Optional `COMMUNITY_MAIL_AGENT_ENABLED=1` and
`COMMUNITY_MAIL_AGENT_USERS` can seed the first configuration; subsequent changes
are saved in SQLite through the administrator UI. The users value is a JSON array
of `{ "email": "owner@example.com", "userId": "existing-app-user-id" }` entries.
Do not put deployment addresses or credentials into a public fork.

The server checks incoming mail every 60 seconds. Only mail received after initial
activation is eligible. New conversations create private mail task sessions; signed
reply references continue the same user's conversation. Results are saved before
the reply is sent, and sending retries reuse one request ID without rerunning tools.
An interrupted job is not automatically executed again. Resend's 24-hour
idempotency window is respected by a shorter 23-hour retry window.

Sender checks use the original MIME and its DKIM signature, not displayed From or
Authentication-Results headers. The signature must match the exact approved sender
domain, cover the full body and important headers, and include the intended mailbox
in the signed To header. Messages more than seven days old, automatic responders,
mailing lists, unsigned or changed mail, and partial-body signatures do not run.
Forwarded or differently signed messages may fail these checks; send a new direct
message from the registered account. Signatures authorize the sender, not commands
embedded in quoted third-party content or attachments.

The current task input is plain text up to 8,000 characters; attachment contents are
not sent to the agent. Per-user task limits and the normal model quotas apply.
Automatic replies carry `Auto-Submitted: auto-replied` and
`X-Auto-Response-Suppress: All`. Delivery acceptance is shown separately from
confirmed delivery. Ordinary inbox viewing and manual replies remain available.

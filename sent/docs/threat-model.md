# Threat model

## Assets
- Site availability and reputation (spam, credential stuffing, scraping).
- Sentinel deployment secrets: per-site secrets, global TOKEN_SECRET,
  PostgreSQL contents, admin credentials, session cookies.
- Visitor privacy (IPs, request metadata).

## Actors
1. **Script abusers** (bots, form spam, scraping farms, LLM crawlers).
2. **Replay attackers** capturing a token once and reusing it at scale.
3. **Cross-site forgery**: rebranding a valid challenge for another action.
4. **Resource-exhaustion attackers** hammering challenge generation.
5. **Curious operators** — self-hosted; admins see everything by design;
   we minimize what's collected to keep the blast radius small.
6. **Malicious insider / stolen admin session** — RBAC + audit log + CSRF.

## Attack → mitigation matrix

| Attack | Mitigation |
| --- | --- |
| Form spam without solving | Token required by middleware; no token ⇒ 403 or evolve policy to challenge |
| Challenge bypass by reusing solution | Challenge ID has one-shot TTL: `challengeOnce` consumes it; Redis NX variant for deployments with multiple instances |
| Replay of a *verification token* | Tokens are single-use by default (replay store) and bound to `{siteKey, action, hostname}` |
| Forging a challenge or token | HMAC-SHA256 with per-site secret / global secret; MAC check is constant-time; difficulty is authenticated inside the blob |
| Expired token/challenge replay | `exp` in the signed payload; server clock authoritative |
| Cross-site / cross-action reuse | Site+action+hostname are authenticated inside the challenge blob and token payload |
| Forced CPU burn | Server enforces difficulty range 10–22; generation rate-limited per client |
| IP spoofing through shared proxies | Trusted-proxy allowlist: `XFF` honored **only** when the direct peer is in the allowlist |
| Brute force admin login | Argon2id (64MB, t=3), per-username rate limit, constant-work on unknown users, no default credentials |
| CSRF on admin API | Per-session CSRF token compared in constant time on every mutation |
| SQL injection | Parameterized pgx queries exclusively; no string interpolation in SQL |
| Secret leakage in logs | Secrets never logged; docker healthchecks print only generic probes |
| Body-based abuse | Never read request bodies in the middleware (no `DoS` via body size) |
| Storage outage | Explicit `fail_open`/`fail_closed` per policy; degraded decisions flagged in events and metrics — protection is never silently bypassed |
| Event buffer overflow | Bounded channel drops oldest, increments `sentinel_events_dropped_total` |

## Explicit limitations (these are public, not hidden)

- Proof-of-work raises the cost of automation; it is **not** a proof of
  humanity. Motivated attackers can also outsource solving to a cloud GPU
  or grid — mitigations (rate limits, risk rules, denylist) do the
  heavy lifting, not the puzzle itself.
- Heuristic scoring is fallible: it can license false positives from
  legitimate power users, and false negatives from slow, distributed
  bots. No component claims to catch every bot.
- In-memory fallbacks mean replay/rate-limit protection is per-instance
  only when Redis is unavailable — this is documented, observable behavior.
- Privileged browser automation (e.g. real Chrome via Playwright) that
  chooses to solve challenges can pass; that is inherent to any
  non-interactive challenge system.

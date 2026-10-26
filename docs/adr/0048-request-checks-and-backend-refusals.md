# ADR-0048: Request checks before forwarding, and backend refusals priced at zero

Status: Accepted (2026-10-26). Findings: bug bash GW-2, GW-3, GW-4, GW-6.

## Context

The bug bash found requests the gateway forwarded although the backend could only refuse them:

- `POST /anthropic/v1/messages/`, `/v1/messages/.`, `/v1/messages//` and `/V1/Messages` match the `create-message`
  operation, pass every check, reach Foundry with the odd path, and come back as Foundry's 404 (GW-2).
- A body sent as `text/plain`, or larger than 32 MB, is parsed by the policy and forwarded; Foundry answers `415` or
  `413` in its own error shape, without `error.type`, which Claude Code reads (GW-3). The policy parses a 40 MB body
  before it refuses an unadmitted model (GW-4).
- Every forwarded request that Foundry refuses before inference (`400`, `404`, `413`, `415`) is a ledger row with
  unknown tokens. Unknown tokens make the person's month `partial` and the history `unpriced_usage`; with
  `resolver.requireCompleteUsage: true` a partial month is a `503` for that person (GW-6).

## Decision

1. **Path.** The policy's first step answers `404 not_found_error` (the same answer as an unmatched operation) unless
   the request path is non-empty segments ending exactly in `/v1/messages`: no trailing slash, no empty, `.` or `..`
   segment, case as written. Nothing is checked, forwarded or counted before it.
2. **Content type and size**, after the token and admission checks and before the body is read: a media type other
   than `application/json` is `415 invalid_request_error`; a `Content-Length` above 33,554,432 bytes (32 MB, the
   Messages API limit, [Claude API errors](https://platform.claude.com/docs/en/api/errors)) is
   `413 request_too_large`. Bug bash 5 adds `411 invalid_request_error` for explicit
   `Transfer-Encoding: chunked`. A request without `Content-Length` alone is not refused or checked
   by size before buffering: HTTP/2 framing is not proven by header absence (UNKNOWNS BB5-H2).
3. **Backend refusals.** In the ledger, a forwarded request whose backend answered 4xx other than 429 has zero tokens
   in every category (known, `inputSource` `backend-refused`), so it prices at zero and keeps the month complete. A
   backend `429` keeps unknown tokens. The row stays in the ledger, attributed to the person and group.

## Consequences

- A typo in a request no longer marks the month incomplete, and no longer blocks a person under
  `requireCompleteUsage`.
- If Foundry ever bills a 4xx answer, recorded spend is low by that amount (assumption BB-G4); the daily Cost
  Management true-up shows it.
- Bodies between 32,000,000 and 33,554,432 bytes still reach Foundry, which may answer its own `413`.

## References

- [Gateway policy](../../infra/gateway/policy/claude-messages.template.xml), [ledger query](../../analytics/ledger.kql).
- [Claude API errors](https://platform.claude.com/docs/en/api/errors), request size limits and error types,
  retrieved 2026-10-26.

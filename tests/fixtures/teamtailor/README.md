# Teamtailor test fixtures

Anonymized JSON:API payloads used by the MSW handlers in
`src/lib/teamtailor/client.test.ts`. All personal data is synthetic —
names, emails, and ids are fabricated and bear no relation to real
candidates.

Pages (`candidates-page-{1,2,3}.json`) model a 3-page pagination:
page 1 has `links.next` → page 2, page 2 → page 3, page 3 has no
`next` (terminal). `links.self` on each page mirrors the URL the
handler matches on.

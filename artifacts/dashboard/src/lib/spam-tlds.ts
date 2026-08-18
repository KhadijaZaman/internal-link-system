/**
 * Re-exports the authoritative spam-TLD set from the shared `@workspace/spam-tlds`
 * package.
 *
 * To add or remove a TLD, edit `lib/spam-tlds/src/index.ts` — not this file.
 * That package is also imported by the API server's weekly freshness-check cron
 * (`artifacts/api-server/src/jobs/checkSpamTldFreshness.ts`), so both consumers
 * always see the same list.
 */
export { SPAM_TLDS } from "@workspace/spam-tlds";

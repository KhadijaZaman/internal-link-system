export * from "./generated/api";
export * from "./generated/types";
// The report endpoint has both a path param and query params, so orval
// emits a zod const (path params, in generated/api) and a TS type (query
// params, in generated/types) with the same name. Re-export explicitly to
// resolve the star-export ambiguity: the zod const keeps the original name,
// the query-params type gets a distinct alias.
export { GetTrackedSubmissionReportParams } from "./generated/api";
export type { GetTrackedSubmissionReportParams as GetTrackedSubmissionReportQuery } from "./generated/types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** "production" | "development". Only "development" (from .dev.vars) can enable the dev sign-in. */
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  /** Secret: signs session cookies. Rotating it signs everyone out. */
  SESSION_SECRET?: string;
  /** Secret: keys the reviewer pseudonym. Never rotate it, or every reviewer gets a new id. */
  REVIEWER_ID_SECRET?: string;
  /** Secret or var: comma-separated reviewer ids (rv_...) that may see progress and export. */
  ADMIN_REVIEWER_IDS?: string;
  /**
   * "1" switches on volunteer line review (task type line_consensus). Production sets it at the launch
   * (docs/runbooks/volunteer-launch.md); a local Worker sets it in .dev.vars.
   */
  CONSENSUS_ENABLED?: string;
  /** .dev.vars only. */
  DEV_AUTH_BYPASS?: string;
}

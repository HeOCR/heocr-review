export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The separately provisioned bucket has no public URL or custom domain. */
  RESTRICTED_REFERENCE_MEDIA?: R2Bucket;
  /** Secret: exact reviewer pseudonym for the private reference queue. */
  RESTRICTED_REFERENCE_REVIEWER_ID?: string;
  /** Set only after lead approval and private eval registration. */
  REGISTERED_CAPTURE_ENABLED?: string;
  REGISTERED_CAPTURE_ROSTER_SHA256?: string;
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
  /** Enables the admin-only synthetic realism queue. */
  SYNTH_REALISM_ENABLED?: string;
  PAGE_SWEEP_ENABLED?: string;
  /** Dedicated intake bindings. Production configuration is provisioned only at approved launch. */
  HANDWRITING_INTAKE_ENABLED?: string;
  HANDWRITING_DB?: D1Database;
  HANDWRITING_MEDIA?: R2Bucket;
  HANDWRITING_CONTROL?: R2Bucket;
  HANDWRITING_KEY?: string;
  /** .dev.vars only. */
  DEV_AUTH_BYPASS?: string;
}

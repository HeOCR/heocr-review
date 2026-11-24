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
  /** Private TRAIN capture storage. Never bind this to the restricted eval bucket. */
  TRAIN_CAPTURE_MEDIA?: R2Bucket;
  CONTRIBUTOR_APP_ENABLED?: string;
  CONTRIBUTOR_CONFIG_SHA256?: string;
  CONTRIBUTOR_HANDWRITING_CONFIG_SHA256?: string;
  CONTRIBUTOR_ROSTER_REVIEWER_ID?: string;
  /** Optional and separately provisioned for non-TRAIN writer assignments. */
  CONTRIBUTOR_DEV_MEDIA?: R2Bucket;
  CONTRIBUTOR_EVAL_MEDIA?: R2Bucket;
  TRAIN_CAPTURE_ENABLED?: string;
  TRAIN_CAPTURE_ROSTER_SHA256?: string;
  FM01_CAPTURE_ENABLED?: string;
  FM01_CAPTURE_ROSTER_SHA256?: string;
  FM01_G_CAPTURE_ENABLED?: string;
  FM01_G_CAPTURE_ROSTER_SHA256?: string;
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
  /** Explicit activation of private pairwise realism ranking. */
  REALISM_RANKING_ENABLED?: string;
  PAGE_SWEEP_ENABLED?: string;
  /** JSON map of private issuer draft batch IDs to ratified projection SHA-256 pins. */
  RATIFIED_ISSUER_SWEEP_PINS?: string;
  /** Dedicated intake bindings. Production configuration is provisioned only at approved launch. */
  HANDWRITING_INTAKE_ENABLED?: string;
  HANDWRITING_DB?: D1Database;
  HANDWRITING_MEDIA?: R2Bucket;
  HANDWRITING_CONTROL?: R2Bucket;
  HANDWRITING_KEY?: string;
  /** .dev.vars only. */
  DEV_AUTH_BYPASS?: string;
}

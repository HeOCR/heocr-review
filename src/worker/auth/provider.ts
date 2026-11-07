import type { Env } from "../env";

/** An identity provider proves a stable subject for a person. The app keeps only a keyed pseudonym of it. */
export interface IdentityProvider {
  /** Namespaces the subject in the pseudonym, so swapping providers never collides ids. */
  id: string;
  enabled(env: Env, request: Request): boolean;
  /** Verify the provider's credential from the sign-in request body; throw HttpError(401) when it is not valid. */
  authenticate(body: Record<string, unknown>, env: Env, request: Request): Promise<{ subject: string }>;
}

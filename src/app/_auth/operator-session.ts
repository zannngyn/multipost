/**
 * What the app layer needs to know about the signed-in operator.
 * Deliberately smaller than the Auth.js `Session`: screens must not start
 * depending on provider-specific fields.
 */
export interface OperatorSession {
  email: string;
  name: string | null;
  /** True only for the guarded local-dev bypass — never in production. */
  isDevFake: boolean;
}

import 'express-session';
import type { SessionUser } from '@cerebro/shared';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** Transient state for an in-flight SSO auth-code flow. */
    sso?: { providerId: string; state: string; nonce: string; codeVerifier: string };
  }
}

declare module 'express' {
  interface Request {
    /** Populated by SessionAuthGuard from either a session or a bearer token. */
    user?: SessionUser;
    /** Which credential authenticated the request. */
    principalType?: 'session' | 'token';
    /** The ApiToken id, when the request was authenticated by a bearer token. */
    apiTokenId?: string;
  }
}

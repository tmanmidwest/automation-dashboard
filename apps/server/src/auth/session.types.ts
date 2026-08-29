import 'express-session';
import type { SessionUser } from '@cerebro/shared';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    /** Transient state for the OIDC auth code flow. */
    oidc?: { state: string; nonce: string; codeVerifier: string };
  }
}

declare module 'express' {
  interface Request {
    /** Populated by SessionAuthGuard when a valid session exists. */
    user?: SessionUser;
  }
}

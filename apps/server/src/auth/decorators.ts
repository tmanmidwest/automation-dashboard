import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Permission, SessionUser } from '@cerebro/shared';

/** Marks a route as accessible without an authenticated session. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires the current user to hold all listed permissions. */
export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...perms: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);

/**
 * Marks a route as reachable only with an interactive session — never a bearer API
 * token. Used for credential management (minting/revoking tokens) so a token cannot
 * mint or escalate other tokens.
 */
export const SESSION_ONLY_KEY = 'sessionOnly';
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

/** Injects the authenticated SessionUser into a controller method. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser | undefined => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return req.user;
  },
);

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, SESSION_ONLY_KEY } from './decorators';
import { AuthService } from './auth.service';
import { TokenAuthService } from './token-auth.service';

/**
 * Global guard: resolves the caller to a SessionUser and attaches it to the request.
 * Two credential types are accepted — an interactive session cookie, or an
 * `Authorization: Bearer` API token — and both produce the same `req.user` shape so
 * downstream permission checks are identical. Routes marked @Public() bypass auth;
 * routes marked @SessionOnly() reject bearer tokens (credential management).
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly tokenAuth: TokenAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request>();

    // 1. Interactive session takes precedence.
    const userId = req.session?.userId;
    if (userId) {
      const user = await this.authService.buildSessionUser(userId);
      if (!user) {
        // Stale session (user deleted/disabled) — clear it.
        req.session?.destroy(() => undefined);
        throw new UnauthorizedException('Session no longer valid');
      }
      req.user = user;
      req.principalType = 'session';
      return true;
    }

    // 2. Fall back to a bearer API token.
    const principal = await this.tokenAuth.resolve(req.headers.authorization);
    if (principal) {
      if (sessionOnly) {
        throw new ForbiddenException('This action requires an interactive session, not an API token.');
      }
      req.user = principal.user;
      req.principalType = 'token';
      req.apiTokenId = principal.tokenId;
      req.oauthClientId = principal.oauthClientId;
      return true;
    }

    // No credentials: advertise the OAuth flow (RFC 9728) so MCP clients can discover it.
    this.setResourceMetadataChallenge(context, req);
    throw new UnauthorizedException('Not authenticated');
  }

  /** Sets `WWW-Authenticate: Bearer resource_metadata=…` so clients find the auth server. */
  private setResourceMetadataChallenge(context: ExecutionContext, req: Request): void {
    const res = context.switchToHttp().getResponse<{ setHeader?: (k: string, v: string) => void }>();
    if (typeof res.setHeader !== 'function') return;
    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
  }
}

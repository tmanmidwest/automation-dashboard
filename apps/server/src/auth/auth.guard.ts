import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './decorators';
import { AuthService } from './auth.service';

/**
 * Global guard: resolves the session → SessionUser and attaches it to the request.
 * Routes marked @Public() bypass authentication.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Not authenticated');
    }

    const user = await this.authService.buildSessionUser(userId);
    if (!user) {
      // Stale session (user deleted/disabled) — clear it.
      req.session?.destroy(() => undefined);
      throw new UnauthorizedException('Session no longer valid');
    }

    req.user = user;
    return true;
  }
}

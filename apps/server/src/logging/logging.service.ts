import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { LogLevel } from '@cerebro/shared';

/**
 * Structured application logger. Writes to the AppLog table (viewable in the UI)
 * AND to stdout (so `docker logs` / Portainer show the same stream).
 */
@Injectable()
export class LoggingService {
  constructor(private readonly prisma: PrismaService) {}

  private async write(level: LogLevel, context: string, message: string, meta?: Record<string, unknown>) {
    // stdout first — never lose a log line to a DB hiccup.
    const line = `[${level.toUpperCase()}] ${context}: ${message}`;
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](line, meta ?? '');
    try {
      await this.prisma.appLog.create({
        data: { level, context, message, meta: (meta as object) ?? undefined },
      });
    } catch {
      // Swallow — logging must never crash the request path.
    }
  }

  debug(context: string, message: string, meta?: Record<string, unknown>) {
    return this.write('debug', context, message, meta);
  }
  info(context: string, message: string, meta?: Record<string, unknown>) {
    return this.write('info', context, message, meta);
  }
  warn(context: string, message: string, meta?: Record<string, unknown>) {
    return this.write('warn', context, message, meta);
  }
  error(context: string, message: string, meta?: Record<string, unknown>) {
    return this.write('error', context, message, meta);
  }

  async query(opts: { level?: LogLevel; context?: string; limit?: number; before?: Date }) {
    const limit = Math.min(opts.limit ?? 100, 500);
    return this.prisma.appLog.findMany({
      where: {
        level: opts.level,
        context: opts.context ? { contains: opts.context, mode: 'insensitive' } : undefined,
        createdAt: opts.before ? { lt: opts.before } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}

import { HttpException, HttpStatus, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

/**
 * Redis-backed brute-force protection for the auth endpoints. Reuses the Redis
 * that already backs sessions (no extra dependency). Two independent brakes:
 *
 *  - **per-IP:** a blunt cap on attempts from one source in a rolling window
 *    (blunts distributed guessing / credential stuffing).
 *  - **per-account:** consecutive failures lock the account for a cooldown. TOTP
 *    failures count against the same account, which closes the "re-mint the MFA
 *    challenge to keep guessing the 6-digit code" bypass (the per-challenge cap
 *    alone did not, since a fresh `login` minted a fresh challenge).
 *
 * Fails **open** if Redis is unreachable — login already depends on Redis for its
 * session store, so a throttle outage must never be what refuses every sign-in.
 */
@Injectable()
export class LoginThrottleService implements OnModuleDestroy {
  private readonly log = new Logger('LoginThrottle');
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  private readonly ipMax = envInt('LOGIN_MAX_PER_IP', 30);
  private readonly ipWindow = envInt('LOGIN_IP_WINDOW_SECONDS', 900);
  private readonly failMax = envInt('LOGIN_MAX_FAILURES', 5);
  private readonly lockSeconds = envInt('LOGIN_LOCK_SECONDS', 900);

  constructor() {
    // ioredis emits 'error' on connection loss; swallow so a Redis blip doesn't
    // crash the process (each command already fails open via its own try/catch).
    this.redis.on('error', (e) => this.log.warn(`redis: ${e?.message ?? e}`));
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private ipKey(ip: string): string {
    return `cerebro:login:ip:${ip}`;
  }
  private failKey(id: string): string {
    return `cerebro:login:fail:${id.toLowerCase()}`;
  }
  private lockKey(id: string): string {
    return `cerebro:login:lock:${id.toLowerCase()}`;
  }

  /** Throw 429 if this IP is over its window cap or the account is locked. */
  async assertAllowed(ip: string | undefined, accountId: string): Promise<void> {
    try {
      const [lockTtl, ipCount] = await Promise.all([
        this.redis.ttl(this.lockKey(accountId)),
        ip ? this.redis.get(this.ipKey(ip)) : Promise.resolve(null),
      ]);
      if (lockTtl > 0) {
        throw this.tooMany(`Too many failed attempts. Try again in ${Math.ceil(lockTtl / 60)} min.`);
      }
      if (ip && Number(ipCount) >= this.ipMax) {
        throw this.tooMany('Too many sign-in attempts from your network. Try again later.');
      }
    } catch (e) {
      if (e instanceof HttpException) throw e; // a real 429 — propagate
      this.log.warn(`throttle check unavailable (allowing): ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Count a failed attempt; lock the account once it crosses the threshold. */
  async recordFailure(ip: string | undefined, accountId: string): Promise<void> {
    try {
      if (ip) {
        const n = await this.redis.incr(this.ipKey(ip));
        if (n === 1) await this.redis.expire(this.ipKey(ip), this.ipWindow);
      }
      const fails = await this.redis.incr(this.failKey(accountId));
      if (fails === 1) await this.redis.expire(this.failKey(accountId), this.lockSeconds);
      if (fails >= this.failMax) {
        await this.redis.set(this.lockKey(accountId), '1', 'EX', this.lockSeconds);
        await this.redis.del(this.failKey(accountId));
      }
    } catch (e) {
      this.log.warn(`throttle record-failure unavailable: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Clear the account's failure/lock state after a successful auth. */
  async recordSuccess(accountId: string): Promise<void> {
    try {
      await this.redis.del(this.failKey(accountId), this.lockKey(accountId));
    } catch {
      /* best-effort */
    }
  }

  private tooMany(msg: string): HttpException {
    return new HttpException(msg, HttpStatus.TOO_MANY_REQUESTS);
  }
}

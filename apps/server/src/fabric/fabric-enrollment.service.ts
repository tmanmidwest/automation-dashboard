import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { generateCredential, parseEnrollToken, sha256 } from './fabric-credentials';

/**
 * The one public, unauthenticated corner of Fabric: an installer exchanges its
 * one-time enrollment token for a long-lived agent credential. Kept in its own
 * service so the public surface is small and obvious.
 */
@Injectable()
export class FabricEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validate an enrollment token and, on success, issue + persist the agent's
   * long-lived credential (sha256-stored). The enrollment token is single-use:
   * it is cleared the moment it is exchanged.
   */
  async enroll(token: string): Promise<{ agentId: string; credential: string; url: string }> {
    const secret = parseEnrollToken(token);
    if (!secret) throw new UnauthorizedException('Invalid enrollment token.');

    const agent = await this.prisma.agent.findUnique({ where: { enrollHash: sha256(secret) } });
    if (
      !agent ||
      agent.status === 'revoked' ||
      !agent.enrollExpires ||
      agent.enrollExpires.getTime() < Date.now()
    ) {
      throw new UnauthorizedException('Enrollment token is invalid or expired.');
    }

    const cred = generateCredential();
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        enrollHash: null,
        enrollExpires: null,
        credPrefix: cred.prefix,
        credHash: cred.hash,
        // Stays 'pending' until the first hello flips it online.
      },
    });

    await this.audit.record({
      action: 'fabric.agent.enrolled',
      target: agent.id,
      meta: { name: agent.name },
    });

    return { agentId: agent.id, credential: cred.plaintext, url: baseUrl() };
  }
}

/** The externally-reachable Cerebro base URL (agents dial this). */
export function baseUrl(): string {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

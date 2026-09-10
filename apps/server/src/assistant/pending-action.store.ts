import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { WireMessage } from './llm-provider';

/** One tool call captured mid-turn, awaiting a resume. */
export interface CapturedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A suspended agent turn: everything needed to resume the loop once the operator approves
 * or denies the paused action. Held in memory only (like the connector job store) — a
 * short-lived handoff between the /chat stream that paused and the /resume stream that
 * continues it.
 */
export interface PendingAction {
  id: string;
  userId: string;
  /** Full wire conversation up to and including the assistant's tool-calling turn, plus
   *  any tool results already produced this turn. */
  messages: WireMessage[];
  /** All tool calls in the paused assistant turn, in order. */
  calls: CapturedCall[];
  /** Index into `calls` of the action awaiting confirmation. */
  index: number;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000; // a paused action expires after 10 minutes

/** In-memory store of suspended agent turns, keyed by a one-time pending id. */
@Injectable()
export class PendingActionStore {
  private readonly map = new Map<string, PendingAction>();

  create(input: Omit<PendingAction, 'id' | 'createdAt'>): string {
    this.sweep();
    const id = randomUUID();
    this.map.set(id, { ...input, id, createdAt: Date.now() });
    return id;
  }

  /** Fetch and remove a pending action (single-use), enforcing owner + TTL. */
  take(id: string, userId: string): PendingAction | undefined {
    const p = this.map.get(id);
    if (!p) return undefined;
    this.map.delete(id);
    if (p.userId !== userId) return undefined;
    if (Date.now() - p.createdAt > TTL_MS) return undefined;
    return p;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.map) {
      if (now - p.createdAt > TTL_MS) this.map.delete(id);
    }
  }
}

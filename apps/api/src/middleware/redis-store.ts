import { createClient, type RedisClientType } from "redis";
import type { RateLimitStore } from "./rate-limit";

/**
 * Shared rate-limit store for multi-instance deployments. Uses INCR + PEXPIRE
 * so concurrent instances see the same counter for a given key.
 */
export class RedisStore implements RateLimitStore {
  private client: RedisClientType;
  private connecting: Promise<void>;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[rate-limit] redis error", err));
    this.connecting = this.client.connect().then(() => undefined);
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    await this.connecting;
    const redisKey = `ratelimit:${key}`;
    const count = await this.client.incr(redisKey);
    if (count === 1) {
      await this.client.pExpire(redisKey, windowMs);
    }
    const ttl = await this.client.pTTL(redisKey);
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
    return { count, resetAt };
  }
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtMs: number;
}

interface ClientBucket {
  timestamps: number[];
}

export class RateLimiter {
  private readonly clients = new Map<string, ClientBucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private lastCleanup = Date.now();

  constructor(options: RateLimiterOptions) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
  }

  public check(clientId: string): RateLimitResult {
    const now = Date.now();
    this.maybePrune(now);

    let bucket = this.clients.get(clientId);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.clients.set(clientId, bucket);
    }

    const windowStart = now - this.windowMs;
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    const resetAtMs = bucket.timestamps.length > 0 ? bucket.timestamps[0]! + this.windowMs : now + this.windowMs;

    if (bucket.timestamps.length >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAtMs,
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - bucket.timestamps.length,
      resetAtMs,
    };
  }

  public reset(clientId?: string): void {
    if (clientId) {
      this.clients.delete(clientId);
    } else {
      this.clients.clear();
    }
  }

  private maybePrune(now: number): void {
    // Prune expired buckets at most once per 60 seconds
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;

    const windowStart = now - this.windowMs;
    for (const [key, bucket] of this.clients.entries()) {
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);
      if (bucket.timestamps.length === 0) {
        this.clients.delete(key);
      }
    }
  }
}

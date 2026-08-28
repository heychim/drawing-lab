import type {
  D1DatabaseLike,
  D1RunResult,
  D1StatementLike,
  RateLimitBindingLike,
  RelayWorkerEnvironment,
} from "../src/domain/relayWorker.js";
import type { BrowserRunBindingLike } from "../src/domain/mcpPreview.js";

type RelayRow = {
  result_id: string;
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
  envelope_version: string;
  canonical_bytes: number;
  ciphertext_bytes: number;
  created_at: number;
  expires_at: number;
};

function cloneBuffer(value: unknown) {
  const source = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value instanceof Uint8Array
      ? value
      : new Uint8Array();
  const target = new ArrayBuffer(source.byteLength);
  new Uint8Array(target).set(source);
  return target;
}

class MemoryD1Statement implements D1StatementLike {
  private values: unknown[] = [];

  constructor(
    private readonly database: MemoryD1Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (!this.query.includes("FROM relay_results") || !this.query.includes("WHERE result_id = ?")) {
      throw new Error("unsupported local D1 first query");
    }
    const row = this.database.rows.get(String(this.values[0]));
    return (row ? structuredClone(row) : null) as T | null;
  }

  async run(): Promise<D1RunResult> {
    if (this.query.includes("INSERT INTO relay_results")) {
      const resultId = String(this.values[0]);
      if (this.database.rows.has(resultId)) throw new Error("UNIQUE constraint failed: relay_results.result_id");
      const createdAt = Number(this.values[6]);
      const windowStart = Number(this.values[8]);
      const createLimit = Number(this.values[9]);
      const liveAt = Number(this.values[10]);
      const newCiphertextBytes = Number(this.values[11]);
      const storageLimit = Number(this.values[12]);
      const createsInWindow = [...this.database.rows.values()]
        .filter((row) => row.created_at >= windowStart).length;
      const liveBytes = [...this.database.rows.values()]
        .filter((row) => row.expires_at > liveAt)
        .reduce((total, row) => total + row.ciphertext_bytes, 0);
      if (createsInWindow >= createLimit || liveBytes + newCiphertextBytes > storageLimit) {
        return { success: true, meta: { changes: 0 } };
      }
      this.database.rows.set(resultId, {
        result_id: resultId,
        ciphertext: cloneBuffer(this.values[1]),
        iv: cloneBuffer(this.values[2]),
        envelope_version: String(this.values[3]),
        canonical_bytes: Number(this.values[4]),
        ciphertext_bytes: Number(this.values[5]),
        created_at: createdAt,
        expires_at: Number(this.values[7]),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("DELETE FROM relay_results")) {
      const expiresAt = Number(this.values[0]);
      let changes = 0;
      for (const [resultId, row] of this.database.rows) {
        if (row.expires_at <= expiresAt) {
          this.database.rows.delete(resultId);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    throw new Error("unsupported local D1 run query");
  }
}

export class MemoryD1Database implements D1DatabaseLike {
  readonly rows = new Map<string, RelayRow>();

  prepare(query: string) {
    return new MemoryD1Statement(this, query);
  }
}

export class MemoryRateLimiter implements RateLimitBindingLike {
  constructor(public success = true) {}

  async limit(_input: { key: string }) {
    return { success: this.success };
  }
}

export class MemoryBrowserRun implements BrowserRunBindingLike {
  readonly calls: Array<{
    action: "screenshot";
    input: {
      html: string;
      selector: string;
      viewport: { width: number; height: number };
    };
  }> = [];

  constructor(
    public responseFactory: () => Response = () => new Response(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-browser-ms-used": "137.8",
        },
      },
    ),
  ) {}

  async quickAction(
    action: "screenshot",
    input: {
      html: string;
      selector: string;
      viewport: { width: number; height: number };
    },
  ) {
    this.calls.push({ action, input: structuredClone(input) });
    return this.responseFactory();
  }
}

export function createMemoryWorkerEnvironment(): RelayWorkerEnvironment & {
  DB: MemoryD1Database;
  RATE_LIMITER: MemoryRateLimiter;
  BROWSER: MemoryBrowserRun;
} {
  return {
    DB: new MemoryD1Database(),
    RATE_LIMITER: new MemoryRateLimiter(),
    BROWSER: new MemoryBrowserRun(),
    ALLOWED_ORIGINS: "https://drawing-lab.test,http://localhost:5173",
  };
}

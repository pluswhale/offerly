/**
 * Chainable Supabase query mock. Every builder method returns the same proxy;
 * awaiting the chain (or calling .single()/.maybeSingle()) yields the terminal
 * result queued for that table. Terminals are consumed FIFO per table.
 */

export interface Terminal {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}

export class FakeSupabaseClient {
  /** Recorded mutating calls for assertions: [table, method, payload]. */
  readonly calls: Array<{ table: string; method: string; payload: unknown }> = [];
  /** Recorded from() calls for assertions (e.g. "table X is never queried"). */
  readonly fromCalls: string[] = [];
  /** Recorded storage calls for assertions. */
  readonly storageCalls: Array<{ bucket: string; method: string; args: unknown[] }> = [];
  /** When set, storage.remove resolves with this error (best-effort delete tests). */
  storageRemoveError: { message: string } | null = null;
  private readonly queues = new Map<string, Terminal[]>();

  constructor(private readonly defaults: Record<string, Terminal> = {}) {}

  readonly storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (path: string) => {
        this.storageCalls.push({ bucket, method: "createSignedUploadUrl", args: [path] });
        return { data: { signedUrl: `https://storage.test/${path}` }, error: null };
      },
      remove: async (paths: string[]) => {
        this.storageCalls.push({ bucket, method: "remove", args: paths });
        return { data: null, error: this.storageRemoveError };
      },
    }),
  };

  /** Queue terminal results for a table (consumed in order, last one repeats). */
  queue(table: string, terminals: Terminal[]): this {
    this.queues.set(table, [...terminals]);
    return this;
  }

  from(table: string): unknown {
    this.fromCalls.push(table);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const nextTerminal = (): Terminal => {
      const q = self.queues.get(table);
      if (q && q.length > 1) return q.shift() ?? {};
      if (q && q.length === 1) return q[0] ?? {};
      return self.defaults[table] ?? { data: null, error: null, count: 0 };
    };
    let terminal = nextTerminal();

    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "then") {
            // Awaiting the chain resolves the current terminal.
            return (resolve: (v: Terminal) => void) => resolve(terminal);
          }
          if (prop === "single" || prop === "maybeSingle") {
            return async () => ({
              data: terminal.data ?? null,
              error: terminal.error ?? null,
            });
          }
          if (prop === "insert" || prop === "upsert" || prop === "delete" || prop === "update") {
            return (payload: unknown) => {
              self.calls.push({ table, method: prop, payload });
              terminal = nextTerminal();
              return proxy;
            };
          }
          // select/eq/in/gte/order/limit/... keep chaining.
          return () => proxy;
        },
      },
    );
    return proxy;
  }
}

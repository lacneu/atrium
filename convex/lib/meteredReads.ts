// A READ METER over a whole function context: every document any helper reads through
// `ctx.db` (get, system.get, collect/take/first/unique/paginate, async iteration) is
// charged as it arrives, by the same measure the projection's bounded steps use
// (`docReadBytes`: the document's UTF-8 JSON size — over, never under, what Convex counts
// against its 16 MiB per-function read limit). Wrapping the context rather than each
// helper is the point: a view composed of many readers (parts, row layouts, transcript
// files, row texts…) is bounded whatever the heavy document turns out to be, without each
// reader having to know about the budget.
//
// Past its `ceiling`, the next charged read THROWS `ReadBudgetExceeded`, so a caller that
// arms it stops at most one document past the line (a document weighs at most 1 MiB).
// Disarmed (`ceiling: Infinity`), the meter only counts.

import { docReadBytes, type ReadMeter } from "./transcriptProjection";

export type ArmedReadMeter = ReadMeter & { ceiling: number };

/** The armed meter passed its ceiling: what was being read is abandoned. */
export class ReadBudgetExceeded extends Error {
  constructor() {
    super("read budget exceeded");
    this.name = "ReadBudgetExceeded";
  }
}

function charge(meter: ArmedReadMeter, value: unknown): void {
  if (Array.isArray(value)) {
    for (const d of value) meter.bytes += docReadBytes(d);
  } else if (value !== null && typeof value === "object" && Array.isArray((value as { page?: unknown }).page)) {
    for (const d of (value as { page: unknown[] }).page) meter.bytes += docReadBytes(d);
  } else {
    meter.bytes += docReadBytes(value);
  }
  if (meter.bytes > meter.ceiling) throw new ReadBudgetExceeded();
}

function meteredIterator(it: AsyncIterator<unknown>, meter: ArmedReadMeter): AsyncIterator<unknown> & AsyncIterable<unknown> {
  const close = async (): Promise<void> => {
    await it.return?.();
  };
  return {
    async next() {
      const r = await it.next();
      if (r.done !== true) {
        try {
          charge(meter, r.value);
        } catch (e) {
          // A throwing `next()` is never followed by `return()` (the loop treats the
          // iterator as finished): release the query stream here.
          await close();
          throw e;
        }
      }
      return r;
    },
    async return(value?: unknown) {
      await close();
      return { done: true as const, value };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function metered<T extends object>(target: T, meter: ArmedReadMeter): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop, obj);
      if (prop === Symbol.asyncIterator && typeof value === "function") {
        return () => meteredIterator((value as () => AsyncIterator<unknown>).call(obj), meter);
      }
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const out: unknown = (value as (...a: unknown[]) => unknown).apply(obj, args);
          if (out instanceof Promise) {
            return out.then((r: unknown) => {
              charge(meter, r);
              return r;
            });
          }
          // A query builder step (withIndex, order, filter…): keep metering its reads.
          return out !== null && typeof out === "object" ? metered(out, meter) : out;
        };
      }
      // `db.system`: a reader of its own.
      return value !== null && typeof value === "object" ? metered(value, meter) : value;
    },
  });
}

/** `ctx` whose database reads are all charged to `meter` (everything else untouched). */
export function meteredCtx<C extends { db: object }>(ctx: C, meter: ArmedReadMeter): C {
  return { ...ctx, db: metered(ctx.db, meter) };
}

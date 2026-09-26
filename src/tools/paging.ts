/**
 * Shared paging and query helpers for the ConnectWise Manage tools.
 *
 * ConnectWise returns a bare array from every collection endpoint and no total
 * count, so paging has to be driven from the client side. These helpers were
 * first written inside the procurement tools and are shared from here now that
 * the agreement tools walk collections the same way.
 */

import { CwManageClient } from "../api-client.js";

/** ConnectWise caps pageSize at 1000 on every paged endpoint. */
export const MAX_PAGE_SIZE = 1000;

/**
 * Read every page of a ConnectWise collection endpoint.
 *
 * ConnectWise returns a bare array and no total count, so the only reliable
 * stop condition is a short page. maxPages guards against an endpoint that
 * ignores paging and hands back the same page forever. Hitting it throws
 * rather than returning a truncated list, because callers total the rows and
 * a silent partial result would give wrong totals.
 */
export async function fetchAllPages<T>(
  client: CwManageClient,
  path: string,
  params: Record<string, string | number | undefined> = {},
  maxPages = 100,
): Promise<T[]> {
  const pageSize = MAX_PAGE_SIZE;
  const all: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const batch = await client.get<T[]>(path, { ...params, page, pageSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
    if (page === maxPages) {
      throw new Error(
        `Pagination limit of ${maxPages} pages reached before ${path} ended. Narrow the request rather than accept a partial result.`,
      );
    }
  }

  return all;
}

/** Run an async mapper over items, at most `limit` in flight at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (let index = cursor++; index < items.length; index = cursor++) {
        results[index] = await mapper(items[index]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/** Combine a caller-supplied conditions string with a filter a tool adds itself. */
export function andConditions(
  ...parts: Array<string | undefined>
): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return kept.map((p) => `(${p})`).join(" and ");
}

/** Round to cents so accumulated floating point noise does not reach the caller. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A ConnectWise reference object, as returned inside almost every record. */
export interface Reference {
  id?: number | null;
  identifier?: string;
  name?: string;
}

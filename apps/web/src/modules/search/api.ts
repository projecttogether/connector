import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import type {
  ContextRequest,
  ContextResponse,
  Item,
  RecentResponse,
  SearchResponse,
} from "@connector/shared/api/search";
import type { SourceSummary } from "@connector/shared/api/sources";
import type { SearchResult as FrameResult } from "@/components/ui/app-frame";
import { api } from "@/lib/api";

/** The sources the signed-in person may use. */
export const sourcesQuery = {
  queryKey: ["sources"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) =>
    api.get<{ items: SourceSummary[] }>("/sources", undefined, signal),
  staleTime: 60_000,
};

export function useSources() {
  return useQuery(sourcesQuery);
}

export function useSearch(q: string, sources: string[]) {
  return useQuery({
    queryKey: ["search", q, sources],
    queryFn: ({ signal }) =>
      api.get<SearchResponse>("/search", { q, sources: sources.join(",") || undefined, limit: 30 }, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
}

/** An address in another app: results link to the app that holds them. */
export function isAppAddress(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/**
 * The search of the app frame: items of every source the person may use
 * (the server asks only those, and each source applies its own rules). Each
 * result opens in its app.
 */
export async function findItems(query: string, signal: AbortSignal): Promise<FrameResult[]> {
  const { results } = await api.get<SearchResponse>("/search", { q: query, limit: 8 }, signal);
  const seen = new Set<string>();
  return results.flatMap((result) => {
    if (!isAppAddress(result.url) || seen.has(result.url)) return [];
    seen.add(result.url);
    return [{ href: result.url, title: result.title, kind: result.source.name }];
  });
}

export function useItem(id: string | null) {
  return useQuery({
    queryKey: ["item", id],
    queryFn: ({ signal }) => api.get<Item>(`/items/${encodeURIComponent(id!)}`, undefined, signal),
    enabled: id !== null,
  });
}

export function useRecent(days: number) {
  return useQuery({
    queryKey: ["recent", days],
    queryFn: ({ signal }) => api.get<RecentResponse>("/recent", { days, limit: 15 }, signal),
    staleTime: 60_000,
  });
}

export function useContextBrief() {
  return useMutation({
    mutationFn: (input: Pick<ContextRequest, "topic">) => api.post<ContextResponse>("/context", input),
  });
}

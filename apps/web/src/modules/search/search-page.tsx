import { useId, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { ResultRow, SourceOutcomes } from "@/components/results";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { cn } from "@/components/ui/utils";
import { useSearch, useSources } from "./api";
import { ItemSheet } from "./item-sheet";
import { messages } from "./messages";

export type SearchParams = { q?: string; sources?: string };

export { highlightParts } from "@/components/results";

/** Search across every source the person may use, with source filters and previews. */
export function SearchPage(props: { params: SearchParams; onChange: (params: SearchParams) => void }) {
  const t = useT(messages);
  const queryId = useId();
  const [text, setText] = useState(props.params.q ?? "");
  const [preview, setPreview] = useState<string | null>(null);
  const sources = useSources().data?.items ?? [];
  const selected = (props.params.sources ?? "").split(",").filter(Boolean);
  const q = props.params.q?.trim() ?? "";
  const results = useSearch(q, selected);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onChange({ ...props.params, q: text.trim() || undefined });
  };
  const toggle = (slug: string) => {
    const next = selected.includes(slug) ? selected.filter((item) => item !== slug) : [...selected, slug];
    props.onChange({ ...props.params, sources: next.join(",") || undefined });
  };

  return (
    <Page className="max-w-4xl">
      <PageHeader title={t("title")} description={t("description")} />
      <form role="search" onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={queryId} className="text-sm font-medium">
            {t("query")}
          </label>
          <Input
            id={queryId}
            type="search"
            value={text}
            placeholder={t("placeholder")}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
        </div>
        <Button type="submit">
          <Search />
          {t("submit")}
        </Button>
      </form>
      {sources.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("sources")}>
          <button
            type="button"
            aria-pressed={selected.length === 0}
            onClick={() => props.onChange({ ...props.params, sources: undefined })}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              selected.length === 0 ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted",
            )}
          >
            {t("allSources")}
          </button>
          {sources.map((source) => (
            <button
              key={source.slug}
              type="button"
              aria-pressed={selected.includes(source.slug)}
              onClick={() => toggle(source.slug)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                selected.includes(source.slug)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-muted",
              )}
            >
              {source.name}
            </button>
          ))}
        </div>
      ) : null}
      {!q ? (
        <EmptyState icon={<Search />} title={t("start")} description={t("startHint")} />
      ) : results.isPending ? (
        <LoadingState />
      ) : results.error ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <section aria-live="polite" className="space-y-2">
          <SourceOutcomes outcomes={results.data.sources} />
          {results.data.results.length === 0 ? (
            <EmptyState icon={<Search />} title={t("noResults")} description={t("noResultsHint")} />
          ) : (
            <>
              <p className="text-muted-foreground text-sm">
                {t("results", { count: results.data.results.length })}
              </p>
              <ul className="divide-y">
                {results.data.results.map((result) => (
                  <ResultRow key={result.id} result={result} onPreview={setPreview} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <ItemSheet id={preview} onClose={() => setPreview(null)} onOpen={setPreview} />
    </Page>
  );
}

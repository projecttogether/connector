import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowRight, Cable, Link2, Search, Unplug } from "lucide-react";
import type { SourceSummary } from "@connector/shared/api/sources";
import { SOURCE_KIND_INFO } from "@connector/shared/sources";
import { Page, PageHeader } from "@/components/ui/page";
import { ResultRow } from "@/components/results";
import { SourceStateBadge } from "@/components/source-state";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useMe } from "@/hooks/use-me";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { ItemSheet } from "@/modules/search/item-sheet";
import { useRecent, useSources } from "@/modules/search/api";
import { useStartLink } from "@/modules/settings/api";
import { messages } from "./messages";

export function kindLabel(kind: SourceSummary["kind"]): string {
  return SOURCE_KIND_INFO[kind].label;
}

function SourceCard({ source }: { source: SourceSummary }) {
  const t = useT(messages);
  const link = useStartLink();
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {source.name}
          <Badge variant="secondary">{kindLabel(source.kind)}</Badge>
        </CardTitle>
        <CardDescription>{source.description || source.holds}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-xs">
        <SourceStateBadge state={source.state} />
        <span className="text-muted-foreground">{source.delivery === "live" ? t("live") : t("webhook")}</span>
      </CardContent>
      {source.linkable ? (
        <CardFooter className="flex-col items-start gap-1">
          {source.linked ? (
            <span className="flex items-center gap-1 text-sm">
              <Link2 className="size-4" aria-hidden />
              {t("linked")}
            </span>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate(source.slug, { onError: (error) => toast.error(errorMessage(error)) })
                }
              >
                <Link2 />
                {t("link")}
              </Button>
              <span className="text-muted-foreground text-xs">{t("linkHint")}</span>
            </>
          )}
        </CardFooter>
      ) : null}
    </Card>
  );
}

export function HomePage() {
  const t = useT(messages);
  const me = useMe();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const sources = useSources();
  const recent = useRecent(7);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (q) void navigate({ to: "/search", search: { q } });
  };
  return (
    <Page className="max-w-5xl">
      <PageHeader
        title={t("greeting", { name: me.name.split(" ")[0] || me.name })}
        description={t("description")}
      />
      <form role="search" onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("search")}
            className="h-12 pl-10 text-base"
          />
        </div>
        <Button type="submit" className="h-12">
          {t("submit")}
        </Button>
      </form>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">{t("sourcesTitle")}</h2>
          <p className="text-muted-foreground text-sm">{t("sourcesDescription")}</p>
        </div>
        {sources.isLoading ? (
          <LoadingState />
        ) : sources.isError || !sources.data ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
        ) : sources.data.items.length === 0 ? (
          <EmptyState icon={<Unplug />} title={t("noSources")} description={t("noSourcesHint")} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sources.data.items.map((source) => (
              <SourceCard key={source.slug} source={source} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="min-w-0 space-y-2">
          <h2 className="text-lg font-semibold">{t("recentTitle")}</h2>
          {recent.isLoading ? (
            <LoadingState />
          ) : recent.isError || !recent.data ? (
            <ErrorState error={recent.error} onRetry={() => void recent.refetch()} />
          ) : recent.data.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("recentEmpty")}</p>
          ) : (
            <ul className="divide-y">
              {recent.data.items.map((item) => (
                <ResultRow key={item.id} result={item} onPreview={setPreview} />
              ))}
            </ul>
          )}
        </section>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cable className="size-4" aria-hidden />
              {t("connectTitle")}
            </CardTitle>
            <CardDescription>{t("connectText")}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild>
              <Link to="/connect">
                {t("connectAction")}
                <ArrowRight />
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
      <ItemSheet id={preview} onClose={() => setPreview(null)} onOpen={setPreview} />
    </Page>
  );
}

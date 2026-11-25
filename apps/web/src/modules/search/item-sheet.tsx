import { ExternalLink } from "lucide-react";
import type { Item } from "@connector/shared/api/search";
import { MarkdownView } from "@/components/markdown";
import { AuthorityBadge } from "@/components/results";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { useItem } from "./api";
import { messages } from "./messages";

function value(entry: Item["metadata"][string]): string {
  if (entry === null) return "–";
  if (Array.isArray(entry)) return entry.length > 0 ? entry.join(", ") : "–";
  if (typeof entry === "boolean") return entry ? "yes" : "no";
  return String(entry);
}

/** One item read in full, as agents get it from fetch. */
export function ItemSheet(props: { id: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const item = useItem(props.id);
  const metadata = item.data
    ? Object.entries(item.data.metadata).filter(
        ([, entry]) => entry !== null && !(Array.isArray(entry) && entry.length === 0),
      )
    : [];
  return (
    <Sheet open={props.id !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {item.isLoading ? (
          <>
            <SheetHeader>
              <SheetTitle>{t("previewTitle")}</SheetTitle>
            </SheetHeader>
            <LoadingState />
          </>
        ) : item.isError || !item.data ? (
          <>
            <SheetHeader>
              <SheetTitle>{t("previewTitle")}</SheetTitle>
            </SheetHeader>
            <ErrorState error={item.error} onRetry={() => void item.refetch()} />
          </>
        ) : (
          <>
            <SheetHeader>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge variant="secondary">{item.data.source.name}</Badge>
                <AuthorityBadge authority={item.data.authority} />
                <span className="text-muted-foreground">{item.data.type}</span>
                {item.data.status ? (
                  <span className="text-muted-foreground">· {item.data.status}</span>
                ) : null}
              </div>
              <SheetTitle className="text-lg">{item.data.title}</SheetTitle>
              <SheetDescription>
                {item.data.date ? t("changed", { date: format.date(item.data.date) }) : null}
              </SheetDescription>
              <div>
                <Button asChild size="sm" variant="outline">
                  <a href={item.data.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    {t("openInApp", { app: item.data.source.name })}
                  </a>
                </Button>
              </div>
            </SheetHeader>
            <div className="space-y-6 px-4 pb-6">
              <MarkdownView markdown={item.data.text} />
              {metadata.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t("facts")}</h3>
                  <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                    {metadata.map(([key, entry]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="break-words">{value(entry)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
              {item.data.related.length > 0 ? (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t("related")}</h3>
                  <ul className="space-y-1 text-sm">
                    {item.data.related.map((related, index) => (
                      <li key={`${related.id ?? related.title}-${index}`}>
                        <span className="text-muted-foreground">{related.relation}: </span>
                        {related.id ? (
                          <button
                            type="button"
                            className="text-link underline-offset-4 hover:underline"
                            onClick={() => props.onOpen(related.id!)}
                          >
                            {related.title}
                          </button>
                        ) : (
                          related.title
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

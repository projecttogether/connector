import { useState } from "react";
import { Activity, Search } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { Pager } from "@/components/ui/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounced } from "@/hooks/use-debounced";
import { useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { useActivity } from "./api";
import { messages } from "./messages";

const PAGE_SIZE = 50;

/** What agents, tokens and bots asked, and how each source answered. */
export function AdminActivityPage() {
  const t = useT(messages);
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const q = useDebounced(query.trim());
  const activity = useActivity(q, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return (
    <Page>
      <PageHeader title={t("activityTitle")} description={t("activityDescription")} />
      <div className="relative max-w-sm">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder={t("activitySearch")}
          aria-label={t("activitySearch")}
          className="pl-8"
        />
      </div>
      {activity.isLoading ? (
        <LoadingState />
      ) : activity.isError || !activity.data ? (
        <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
      ) : activity.data.items.length === 0 ? (
        <EmptyState icon={<Activity />} title={t("noActivity")} description={t("noActivityHint")} />
      ) : (
        <>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colWhen")}</TableHead>
                  <TableHead>{t("colWho")}</TableHead>
                  <TableHead>{t("colWhat")}</TableHead>
                  <TableHead>{t("colResults")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activity.data.items.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="align-top whitespace-nowrap">
                      <time dateTime={entry.createdAt} title={format.relative(entry.createdAt)}>
                        {format.dateTime(entry.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">
                      <div className="font-medium">{entry.actor}</div>
                      <div className="text-muted-foreground text-xs">
                        {entry.client ? `${entry.client} · ` : ""}
                        {t(`channel_${entry.channel}`)}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-64 align-top whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="font-mono">
                          {entry.action}
                        </Badge>
                        {entry.query ? <span className="break-words">{entry.query}</span> : null}
                      </div>
                      {entry.sources.length > 0 ? (
                        <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-xs">
                          {entry.sources.map((source) => (
                            <span key={source.slug} className={source.ok ? undefined : "text-destructive"}>
                              {source.slug}: {source.ok ? source.count : (source.error ?? "×")}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      {entry.results}
                      <div className="text-muted-foreground text-xs">{entry.ms} ms</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <Pager page={page} pageSize={PAGE_SIZE} total={activity.data.total} onPage={setPage} />
        </>
      )}
    </Page>
  );
}

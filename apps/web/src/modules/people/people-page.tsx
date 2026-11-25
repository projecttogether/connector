import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { Contact, Search } from "lucide-react";
import type { Colleague } from "@connector/shared/api/users";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounced } from "@/hooks/use-debounced";
import { defineMessages, useT } from "@/i18n";
import { api } from "@/lib/api";
import { appRoute } from "@/routes/app";

const messages = defineMessages({
  en: {
    title: "People",
    description:
      "Colleagues from the directory, by name, email address, job title or group. Agents use the same directory.",
    search: "Search people",
    start: "Find a colleague",
    startHint: "Type a name, an email address, a job title or a team.",
    none: "Nobody found",
    colName: "Name",
    colTitle: "Job title",
    colGroups: "Groups",
  },
});

export function PeoplePage() {
  const t = useT(messages);
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim());
  const people = useQuery({
    queryKey: ["people", q],
    queryFn: ({ signal }) => api.get<{ items: Colleague[] }>("/people", { q, limit: 50 }, signal),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
  return (
    <Page className="max-w-5xl">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="relative max-w-md">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search")}
          aria-label={t("search")}
          className="pl-8"
        />
      </div>
      {!q ? (
        <EmptyState icon={<Contact />} title={t("start")} description={t("startHint")} />
      ) : people.isPending ? (
        <LoadingState />
      ) : people.isError || !people.data ? (
        <ErrorState error={people.error} onRetry={() => void people.refetch()} />
      ) : people.data.items.length === 0 ? (
        <EmptyState icon={<Contact />} title={t("none")} />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colTitle")}</TableHead>
                <TableHead>{t("colGroups")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {people.data.items.map((person) => (
                <TableRow key={person.email}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="font-medium">{person.name}</div>
                    <a
                      href={`mailto:${person.email}`}
                      className="text-muted-foreground text-sm break-all hover:underline"
                    >
                      {person.email}
                    </a>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">{person.title ?? "–"}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      {person.groups.map((group) => (
                        <Badge key={group} variant="outline" className="font-normal">
                          {group}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </Page>
  );
}

const peopleRoute = createRoute({ getParentRoute: () => appRoute, path: "/people", component: PeoplePage });

export const routes: AnyRoute[] = [peopleRoute];

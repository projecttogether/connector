import { useId, useState, type FormEvent } from "react";
import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { Info, Sparkles } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { ResultRow, SourceOutcomes } from "@/components/results";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { defineMessages, useT } from "@/i18n";
import { appRoute } from "@/routes/app";
import { useContextBrief } from "@/modules/search/api";
import { ItemSheet } from "@/modules/search/item-sheet";

const messages = defineMessages({
  en: {
    title: "Context",
    description:
      "Everything the connected apps hold on a topic, in the source order: what AI agents get when they ask for context.",
    topic: "Topic or question",
    placeholder: "e.g. travel expenses for volunteers",
    submit: "Get context",
    start: "What do we know about…?",
    startHint:
      "Rules come first, then decisions in force, the knowledge base, history, records and the library.",
    empty: "Nothing found on this topic",
    notes: "Notes",
  },
});

export function ContextPage() {
  const t = useT(messages);
  const id = useId();
  const [topic, setTopic] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const brief = useContextBrief();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (topic.trim().length >= 2) brief.mutate({ topic: topic.trim() });
  };
  return (
    <Page className="max-w-4xl">
      <PageHeader title={t("title")} description={t("description")} />
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={id} className="text-sm font-medium">
            {t("topic")}
          </label>
          <Input
            id={id}
            value={topic}
            placeholder={t("placeholder")}
            onChange={(event) => setTopic(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={brief.isPending || topic.trim().length < 2}>
          <Sparkles />
          {t("submit")}
        </Button>
      </form>
      {brief.isIdle ? (
        <EmptyState icon={<Sparkles />} title={t("start")} description={t("startHint")} />
      ) : brief.isPending ? (
        <LoadingState />
      ) : brief.isError || !brief.data ? (
        <ErrorState error={brief.error} />
      ) : (
        <div className="space-y-6">
          <SourceOutcomes outcomes={brief.data.sources} />
          {brief.data.notes.length > 0 ? (
            <Alert>
              <Info />
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-4">
                  {brief.data.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {brief.data.sections.length === 0 ? (
            <EmptyState icon={<Sparkles />} title={t("empty")} />
          ) : (
            brief.data.sections.map((section, index) => (
              <section key={section.authority} className="space-y-1">
                <h2 className="text-lg font-semibold">
                  {index + 1}. {section.label}
                </h2>
                <p className="text-muted-foreground text-sm">{section.description}</p>
                <ul className="divide-y">
                  {section.items.map((item) => (
                    <ResultRow key={item.id} result={item} onPreview={setPreview} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
      <ItemSheet id={preview} onClose={() => setPreview(null)} onOpen={setPreview} />
    </Page>
  );
}

const contextRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/context",
  component: ContextPage,
});

export const routes: AnyRoute[] = [contextRoute];

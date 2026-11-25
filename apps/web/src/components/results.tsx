import type { ReactNode } from "react";
import { Eye, ExternalLink } from "lucide-react";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type SearchResult,
  type SourceOutcome,
} from "@connector/shared/api/search";
import { AUTHORITY_LABELS, type Authority } from "@connector/shared/sources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { defineMessages, useT } from "@/i18n";
import { useFormatter } from "@/lib/format";
import { cn } from "@/components/ui/utils";

const messages = defineMessages({
  en: {
    preview: "Preview",
    opensNewTab: "(opens in a new tab)",
    answered: "{name}: {count}",
    failed: "{name} did not answer: {error}",
  },
});

/** Splits a snippet at the highlight marks into text and <mark> parts. */
export function highlightParts(snippet: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      parts.push(rest.replaceAll(HIGHLIGHT_END, ""));
      break;
    }
    if (start > 0) parts.push(rest.slice(0, start).replaceAll(HIGHLIGHT_END, ""));
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    const marked = end === -1 ? rest.slice(start + 1) : rest.slice(start + 1, end);
    parts.push(
      <mark key={key++} className="rounded-sm bg-yellow-200 px-0.5 text-inherit dark:bg-yellow-500/40">
        {marked}
      </mark>,
    );
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return parts;
}

const AUTHORITY_STYLE: Record<Authority, string> = {
  rules: "border-violet-500/50 text-violet-700 dark:text-violet-300",
  decision: "border-emerald-600/50 text-emerald-700 dark:text-emerald-300",
  knowledge: "border-blue-500/50 text-blue-700 dark:text-blue-300",
  history: "text-muted-foreground",
  record: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  library: "border-teal-500/50 text-teal-700 dark:text-teal-300",
};

export function AuthorityBadge({ authority }: { authority: Authority }) {
  return (
    <Badge variant="outline" className={cn("font-normal", AUTHORITY_STYLE[authority])}>
      {AUTHORITY_LABELS[authority]}
    </Badge>
  );
}

/** One result: title (to the app), source, level in the source order, snippet. */
export function ResultRow(props: { result: SearchResult; onPreview?: (id: string) => void }) {
  const t = useT(messages);
  const format = useFormatter();
  const { result } = props;
  return (
    <li className="space-y-1.5 py-4">
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant="secondary">{result.source.name}</Badge>
        <AuthorityBadge authority={result.authority} />
        <span>{result.type}</span>
        {result.status ? <span>· {result.status}</span> : null}
        {result.date ? <span>· {format.date(result.date)}</span> : null}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-link inline-flex items-center gap-1 text-base font-medium underline-offset-4 hover:underline"
        >
          {result.title}
          <ExternalLink className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">{t("opensNewTab")}</span>
        </a>
        {props.onPreview ? (
          <Button variant="ghost" size="sm" onClick={() => props.onPreview?.(result.id)}>
            <Eye />
            {t("preview")}
          </Button>
        ) : null}
      </div>
      {result.snippet ? <p className="text-sm leading-6">{highlightParts(result.snippet)}</p> : null}
    </li>
  );
}

/** "Handbook: 5 · CRM did not answer: …" */
export function SourceOutcomes({ outcomes }: { outcomes: SourceOutcome[] }) {
  const t = useT(messages);
  if (outcomes.length === 0) return null;
  return (
    <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="source-outcomes">
      {outcomes.map((outcome) => (
        <span key={outcome.slug} className={outcome.ok ? undefined : "text-destructive"}>
          {outcome.ok
            ? t("answered", { name: outcome.name, count: outcome.count })
            : t("failed", { name: outcome.name, error: outcome.error ?? "" })}
        </span>
      ))}
    </p>
  );
}

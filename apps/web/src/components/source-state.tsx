import { CircleCheck, CircleHelp, CircleX, TriangleAlert } from "lucide-react";
import type { SourceState } from "@connector/shared/api/sources";
import { Badge } from "@/components/ui/badge";
import { defineMessages, useT } from "@/i18n";

const messages = defineMessages({
  en: {
    state_ok: "Working",
    state_failing: "Failing",
    state_waiting: "Waiting for first delivery",
    state_setup: "Needs setup",
    state_unchecked: "Not checked yet",
    state_off: "Off",
  },
});

const STATE_STYLE: Record<SourceState, string> = {
  ok: "border-emerald-600/40 text-emerald-700 dark:text-emerald-300",
  failing: "",
  waiting: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  setup: "border-amber-500/50 text-amber-700 dark:text-amber-300",
  unchecked: "text-muted-foreground",
  off: "text-muted-foreground",
};

/** How a source is doing, in the same words on the status page and the home page. */
export function SourceStateBadge({ state }: { state: SourceState }) {
  const t = useT(messages);
  return (
    <Badge variant={state === "failing" ? "destructive" : "outline"} className={STATE_STYLE[state]}>
      {state === "ok" ? <CircleCheck aria-hidden /> : null}
      {state === "failing" ? <CircleX aria-hidden /> : null}
      {state === "waiting" || state === "setup" ? <TriangleAlert aria-hidden /> : null}
      {state === "unchecked" ? <CircleHelp aria-hidden /> : null}
      {t(`state_${state}`)}
    </Badge>
  );
}

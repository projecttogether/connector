import { useId, type ReactNode } from "react";
import { Check, CircleCheck, CircleX } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/utils";

/** One numbered step of a setup guide; `done` shows a check instead of the number. */
export function GuideStep(props: {
  number: number;
  title: ReactNode;
  description?: ReactNode;
  done?: boolean;
  /** A step that cannot start yet shows only its title. */
  locked?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className={cn("gap-4", props.locked && "opacity-60")} data-testid={`step-${props.number}`}>
      <CardHeader className="flex flex-row items-start gap-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-medium",
            props.done && "border-emerald-600 bg-emerald-600 text-white",
          )}
          aria-hidden
        >
          {props.done ? <Check className="size-4" /> : props.number}
        </span>
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base">{props.title}</CardTitle>
          {props.description && !props.locked ? <CardDescription>{props.description}</CardDescription> : null}
        </div>
      </CardHeader>
      {props.children && !props.locked ? (
        <CardContent className="space-y-4 sm:pl-16">{props.children}</CardContent>
      ) : null}
    </Card>
  );
}

/**
 * A value to copy into another app: label, the value in monospace, and a copy
 * button. A `secret` stays hidden until shown with the eye button.
 */
export function CopyRow(props: {
  label: ReactNode;
  value: string;
  copy?: boolean;
  secret?: boolean;
  testId?: string;
}) {
  const labelId = useId();
  return (
    <div className="grid gap-1.5 sm:grid-cols-[12rem_1fr] sm:items-center sm:gap-3">
      <span className="text-muted-foreground text-sm" id={labelId}>
        {props.label}
      </span>
      {props.secret ? (
        <SecretInput
          aria-labelledby={labelId}
          value={props.value}
          readOnly
          copyable
          className="min-w-0"
          inputClassName="font-mono text-xs"
          data-testid={props.testId}
        />
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <code
            className="bg-muted min-w-0 flex-1 rounded-md px-3 py-1.5 font-mono text-xs break-all"
            data-testid={props.testId}
          >
            {props.value}
          </code>
          {props.copy === false ? null : <CopyButton text={props.value} />}
        </div>
      )}
    </div>
  );
}

/** The outcome of a test or a wait: working, failing, or still waiting. */
export function Outcome(props: {
  state: "ok" | "failed" | "waiting";
  title: ReactNode;
  children?: ReactNode;
}) {
  if (props.state === "waiting")
    return (
      <div className="text-muted-foreground flex items-start gap-2 text-sm" role="status">
        <Spinner className="mt-0.5" />
        <div className="space-y-1">
          <p className="text-foreground font-medium">{props.title}</p>
          {props.children}
        </div>
      </div>
    );
  return (
    <Alert
      variant={props.state === "failed" ? "destructive" : "default"}
      className={props.state === "ok" ? "border-emerald-600/40" : undefined}
      role="status"
    >
      {props.state === "ok" ? <CircleCheck className="text-emerald-600" /> : <CircleX />}
      <AlertTitle>{props.title}</AlertTitle>
      {props.children ? <AlertDescription>{props.children}</AlertDescription> : null}
    </Alert>
  );
}

/** A link to a page of another app, opened in a new tab. */
export function AppLink(props: { href: string | null; children: ReactNode }) {
  if (!props.href) return <>{props.children}</>;
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="text-link font-medium underline-offset-4 hover:underline"
    >
      {props.children}
    </a>
  );
}

/** An app's address as the admin typed it, without a trailing slash; null while it is no web address. */
export function baseUrlOf(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin + url.pathname.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}

/** A translated text with a `{link}` placeholder, the link in its place. */
export function withLink(text: string, link: ReactNode): ReactNode {
  const [before, after] = text.split("{link}");
  return (
    <>
      {before}
      {link}
      {after}
    </>
  );
}

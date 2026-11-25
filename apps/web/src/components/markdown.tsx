import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui/utils";
import { defineMessages, useT } from "@/i18n";

/**
 * Renders an item's text (Markdown from the apps; never HTML): GitHub-
 * flavored Markdown, links open in a new tab, since they lead to the
 * connected apps or outside.
 */
export type MarkdownViewProps = {
  markdown: string;
  className?: string;
};

const messages = defineMessages({
  en: {
    opensNewTab: "(opens in a new tab)",
  },
});

/** Nesting deeper than the renderer handles in time (thousands of quotes or list markers). */
export function tooComplex(markdown: string): boolean {
  return markdown.length > 300_000 || /(?:>\s*){200,}/.test(markdown) || /(?:[-*+]\s+){200,}/.test(markdown);
}

function MarkdownLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  const t = useT(messages);
  const className = "text-link font-medium underline underline-offset-4 hover:no-underline";
  if (!href) return <span>{children}</span>;
  if (href.startsWith("#")) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  if (!/^(https?:|mailto:)/i.test(href))
    return <span className="underline decoration-dotted">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> {t("opensNewTab")}</span>
    </a>
  );
}

const headingClass = "scroll-mt-20 font-semibold tracking-tight";

const components: Components = {
  h1: ({ node: _node, ...props }) => <h1 {...props} className={cn(headingClass, "mt-6 mb-3 text-xl")} />,
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className={cn(headingClass, "mt-6 mb-2 border-b pb-1 text-lg")} />
  ),
  h3: ({ node: _node, ...props }) => <h3 {...props} className={cn(headingClass, "mt-5 mb-2 text-base")} />,
  h4: ({ node: _node, ...props }) => <h4 {...props} className={cn(headingClass, "mt-4 mb-2 text-sm")} />,
  h5: ({ node: _node, ...props }) => <h5 {...props} className={cn(headingClass, "mt-4 mb-2 text-sm")} />,
  h6: ({ node: _node, ...props }) => (
    <h6 {...props} className={cn(headingClass, "text-muted-foreground mt-4 mb-2 text-sm")} />
  ),
  p: ({ node: _node, ...props }) => <p {...props} className="my-3 leading-7" />,
  ul: ({ node: _node, className, ...props }) => (
    <ul
      {...props}
      className={cn(
        "my-3 ml-6 list-disc space-y-1",
        className?.includes("contains-task-list") && "ml-1 list-none",
      )}
    />
  ),
  ol: ({ node: _node, ...props }) => <ol {...props} className="my-3 ml-6 list-decimal space-y-1" />,
  li: ({ node: _node, ...props }) => <li {...props} className="leading-7" />,
  input: ({ node: _node, ...props }) => (
    <input {...props} className="mr-2 size-4 align-middle" aria-label="Task" />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="text-muted-foreground my-4 border-l-4 pl-4 italic" />
  ),
  a: ({ node: _node, href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ node: _node, alt }) => <span className="text-muted-foreground">[{alt || "image"}]</span>,
  hr: () => <hr className="my-6" />,
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="bg-muted my-4 overflow-x-auto rounded-md p-4 text-sm leading-6 [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code {...props} className={cn("bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]", className)} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-4 w-full overflow-x-auto">
      <table {...props} className="w-full border-collapse text-sm" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th {...props} className="bg-muted/60 border px-3 py-2 text-left align-top font-semibold" />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className="border px-3 py-2 align-top" />,
};

export function MarkdownView(props: MarkdownViewProps) {
  if (tooComplex(props.markdown)) {
    return (
      <div className={cn("text-foreground min-w-0 text-sm break-words whitespace-pre-wrap", props.className)}>
        {props.markdown}
      </div>
    );
  }
  return (
    <div className={cn("text-foreground min-w-0 text-sm break-words", props.className)}>
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
        {props.markdown}
      </ReactMarkdown>
    </div>
  );
}

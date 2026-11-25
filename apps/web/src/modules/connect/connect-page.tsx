import type { ReactNode } from "react";
import { createRoute, Link, type AnyRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { defineMessages, useT } from "@/i18n";
import { appRoute } from "@/routes/app";
import { useConnectInfo } from "@/modules/settings/api";

const messages = defineMessages({
  en: {
    title: "Connect an agent",
    description:
      "AI assistants connect to Connector through MCP, an open standard. One connection gives them every source you may use.",
    mcpUrl: "MCP address",
    safeTitle: "Your agent sees what you see",
    safeText:
      "It signs in as you, gets only the sources and items you may see, and links every answer to its source. It can propose Handbook changes for review, never publish them. Disconnect it any time in Settings.",
    claude: "Claude (web, desktop, mobile)",
    claude1: "Open Settings → Connectors and choose Add custom connector.",
    claude2: "Name it, paste the MCP address, and add it.",
    claude3: "Choose Connect and sign in to Connector when asked.",
    chatgpt: "ChatGPT",
    chatgpt1:
      "Open Settings → Apps & Connectors → Advanced settings and turn on Developer mode (workspace admins may have to allow it).",
    chatgpt2: "Choose Create, name the connector, paste the MCP address, and choose OAuth.",
    chatgpt3: "Sign in to Connector when asked. Search and fetch also work in deep research.",
    lechat: "Mistral Le Chat",
    lechat1: "Open Intelligence → Connectors and choose Add connector.",
    lechat2: "Choose Custom MCP connector, name it, and paste the MCP address.",
    lechat3: "Choose Connect and sign in to Connector when asked.",
    other: "Other MCP clients and scripts",
    other1:
      "Add a remote MCP server (Streamable HTTP) with the MCP address. Clients that support OAuth sign in by themselves.",
    other2:
      "Clients without OAuth: create a personal token in Settings and send it as “Authorization: Bearer <token>”.",
    claudeCode: "For Claude Code:",
    settings: "Open Settings",
  },
});

function Steps({ title, steps, children }: { title: string; steps: string[]; children?: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1.5 pl-5">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {children}
      </CardContent>
    </Card>
  );
}

export function ConnectPage() {
  const t = useT(messages);
  const info = useConnectInfo();
  const url = info.data?.mcpUrl ?? "";
  return (
    <Page className="max-w-5xl">
      <PageHeader title={t("title")} description={t("description")} />
      <Card>
        <CardHeader>
          <CardTitle id="mcp-url-label">{t("mcpUrl")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {info.isLoading ? (
            <LoadingState />
          ) : info.isError ? (
            <ErrorState error={info.error} onRetry={() => void info.refetch()} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <code
                aria-labelledby="mcp-url-label"
                className="bg-muted min-w-0 flex-1 rounded-md px-3 py-2 font-mono text-sm break-all"
              >
                {url}
              </code>
              <CopyButton text={url} />
            </div>
          )}
        </CardContent>
      </Card>
      <Alert>
        <ShieldCheck />
        <AlertTitle>{t("safeTitle")}</AlertTitle>
        <AlertDescription>{t("safeText")}</AlertDescription>
      </Alert>
      <div className="grid gap-4 md:grid-cols-2">
        <Steps title={t("claude")} steps={[t("claude1"), t("claude2"), t("claude3")]} />
        <Steps title={t("chatgpt")} steps={[t("chatgpt1"), t("chatgpt2"), t("chatgpt3")]} />
        <Steps title={t("lechat")} steps={[t("lechat1"), t("lechat2"), t("lechat3")]} />
        <Steps title={t("other")} steps={[t("other1"), t("other2")]}>
          <p className="text-muted-foreground">{t("claudeCode")}</p>
          <code className="bg-muted block overflow-x-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre">
            {`claude mcp add --transport http connector ${url}`}
          </code>
          <Link to="/settings" className="text-link underline-offset-4 hover:underline">
            {t("settings")}
          </Link>
        </Steps>
      </div>
    </Page>
  );
}

const connectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/connect",
  component: ConnectPage,
});

export const routes: AnyRoute[] = [connectRoute];

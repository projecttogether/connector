import { Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
import { Page, PageHeader } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/i18n";
import { AdminTokens } from "./admin-tokens";
import { messages } from "./messages";

/** The Support Agent: its setup guide. */
function SupportAgentCard() {
  const t = useT(messages);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden />
          {t("supportAgentTitle")}
        </CardTitle>
        <CardDescription>{t("supportAgentText")}</CardDescription>
        <CardAction>
          <Button asChild size="sm" variant="outline">
            <Link to="/admin/setup/support-agent">{t("setUpSupportAgent")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

export function AdminServiceTokensPage() {
  const t = useT(messages);
  return (
    <Page>
      <PageHeader title={t("tokensTitle")} description={t("tokensDescription")} />
      <SupportAgentCard />
      <Card>
        <CardContent>
          <AdminTokens
            kind="service"
            newLabel={t("newToken")}
            createTitle={t("createTokenTitle")}
            createDescription={t("createTokenDescription")}
            nameHint={t("tokenNameHint")}
            empty={t("noTokens")}
            emptyHint={t("noTokensHint")}
          />
        </CardContent>
      </Card>
    </Page>
  );
}

import type { SetupApp } from "@connector/shared/api/status";
import { SOURCE_KIND_INFO, type SourceKind } from "@connector/shared/sources";
import { Page, PageHeader } from "@/components/ui/page";
import { useT } from "@/i18n";
import { IamGuide, SupportAgentGuide } from "./app-guides";
import { messages } from "./messages";
import { SourceGuide } from "./source-guide";

const DESCRIPTIONS: Record<"iam" | "support-agent", string> = {
  iam: "IAM adds, updates and deactivates people here and fills their groups, over SCIM 2.0.",
  "support-agent":
    "The Support Agent answers questions in Slack from what Connector finds, as a knowledge source.",
};

/** A step-by-step guide to connect one app (Administration → Status; the breadcrumbs lead back). */
export function SetupPage(props: { app: SetupApp; sourceId?: string; onCreated: (id: string) => void }) {
  const t = useT(messages);
  const kind = props.app === "iam" || props.app === "support-agent" ? null : (props.app as SourceKind);
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={t(`title_${props.app}`)}
        description={kind ? SOURCE_KIND_INFO[kind].holds : DESCRIPTIONS[props.app as "iam" | "support-agent"]}
      />
      {kind ? (
        <SourceGuide key={kind} kind={kind} sourceId={props.sourceId} onCreated={props.onCreated} />
      ) : props.app === "iam" ? (
        <IamGuide />
      ) : (
        <SupportAgentGuide />
      )}
    </Page>
  );
}

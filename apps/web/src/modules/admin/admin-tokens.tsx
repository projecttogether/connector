import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Plus } from "lucide-react";
import type { ServiceToken } from "@connector/shared/api/tokens";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { CreateTokenDialog, TokenSecretDialog } from "@/modules/settings/token-dialogs";
import { useAdminTokens, useCreateAdminToken, useRevokeAdminToken, type TokenKind } from "./api";
import { messages } from "./messages";

/** A list of service or SCIM tokens with create (secret shown once) and revoke. */
export function AdminTokens(props: {
  kind: TokenKind;
  newLabel: string;
  createTitle: string;
  createDescription: string;
  nameHint: string;
  empty: string;
  emptyHint?: string;
}) {
  const t = useT(messages);
  const format = useFormatter();
  const tokens = useAdminTokens(props.kind);
  const create = useCreateAdminToken(props.kind);
  const revoke = useRevokeAdminToken(props.kind);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ServiceToken | null>(null);
  return (
    <div className="space-y-3">
      <div>
        <Button
          size="sm"
          onClick={() => {
            create.reset();
            setCreating(true);
          }}
        >
          <Plus />
          {props.newLabel}
        </Button>
      </div>
      {tokens.isLoading ? (
        <LoadingState />
      ) : tokens.isError || !tokens.data ? (
        <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.items.length === 0 ? (
        <EmptyState icon={<KeyRound />} title={props.empty} description={props.emptyHint} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colName")}</TableHead>
              <TableHead>{t("colToken")}</TableHead>
              <TableHead>{t("colCreatedBy")}</TableHead>
              <TableHead>{t("colLastUsed")}</TableHead>
              <TableHead>{t("colExpires")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("revoke")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.data.items.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium whitespace-normal">
                  {token.name}
                  <div className="text-muted-foreground text-xs font-normal">
                    {format.dateTime(token.createdAt)}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
                <TableCell className="whitespace-normal">{token.createdBy ?? "–"}</TableCell>
                <TableCell>{token.lastUsedAt ? format.relative(token.lastUsedAt) : t("notUsed")}</TableCell>
                <TableCell>{token.expiresAt ? format.dateTime(token.expiresAt) : t("never")}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(token)}>
                    {t("revoke")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {creating ? (
        <CreateTokenDialog
          open
          onOpenChange={setCreating}
          title={props.createTitle}
          description={props.createDescription}
          nameHint={props.nameHint}
          pending={create.isPending}
          error={create.error}
          onCreate={(input) =>
            create.mutate(input, {
              onSuccess: (created) => {
                setCreating(false);
                setSecret(created.secret);
                toast.success(t("tokenCreated"));
              },
            })
          }
        />
      ) : null}
      <TokenSecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("revokeTitle", { name: revoking?.name ?? "" })}
        description={t("revokeDescription")}
        confirmLabel={t("revoke")}
        destructive
        onConfirm={() =>
          revoking &&
          revoke.mutateAsync(revoking.id).then(
            () => toast.success(t("revoked")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </div>
  );
}

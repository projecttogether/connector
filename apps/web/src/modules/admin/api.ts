import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  HandbookSpaceList,
  Source,
  SourceCheck,
  SourceCreate,
  SourceUpdate,
  WebhookSecretCreated,
} from "@connector/shared/api/sources";
import type { AdminStatus } from "@connector/shared/api/status";
import type { ServiceToken, TokenCreate, TokenCreated } from "@connector/shared/api/tokens";
import type {
  ActivityEntry,
  DirectoryStatus,
  Group,
  Person,
  PersonUpdate,
} from "@connector/shared/api/users";
import { api } from "@/lib/api";

export const adminKeys = {
  status: ["admin", "status"] as const,
  sources: ["admin", "sources"] as const,
  spaces: (id: string) => ["admin", "sources", id, "spaces"] as const,
  people: (q: string) => ["admin", "people", q] as const,
  tokens: (kind: TokenKind) => ["admin", `${kind}-tokens`] as const,
  groups: ["admin", "groups"] as const,
  directory: ["admin", "directory"] as const,
  activity: (q: string, limit: number, offset: number) =>
    ["admin", "activity", { q, limit, offset }] as const,
};

/** Refreshes the admin list, the status and what people see of sources. */
function useRefreshSources() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: adminKeys.sources }),
      client.invalidateQueries({ queryKey: adminKeys.status }),
      client.invalidateQueries({ queryKey: ["sources"] }),
    ]);
}

/** The status page; `poll` refreshes it while it is open. */
export function useAdminStatus(options: { poll?: number } = {}) {
  return useQuery({
    queryKey: adminKeys.status,
    queryFn: ({ signal }) => api.get<AdminStatus>("/admin/status", undefined, signal),
    refetchInterval: options.poll,
  });
}

/** Handbook's spaces, read with the source's service token. */
export function useHandbookSpaces(id: string | null) {
  return useQuery({
    queryKey: adminKeys.spaces(id ?? ""),
    queryFn: ({ signal }) => api.get<HandbookSpaceList>(`/admin/sources/${id}/spaces`, undefined, signal),
    enabled: id !== null,
    retry: false,
  });
}

/** The sources as admins see them; `poll` refreshes them while it returns an interval (e.g. waiting for a delivery). */
export function useAdminSources(options: { poll?: (items: Source[]) => number | false } = {}) {
  const { poll } = options;
  return useQuery({
    queryKey: adminKeys.sources,
    queryFn: ({ signal }) => api.get<{ items: Source[] }>("/admin/sources", undefined, signal),
    refetchInterval: poll ? (query) => poll(query.state.data?.items ?? []) : undefined,
  });
}

export function useCreateSource() {
  const refresh = useRefreshSources();
  return useMutation({
    mutationFn: (input: SourceCreate) => api.post<Source>("/admin/sources", input),
    onSettled: refresh,
  });
}

export function useUpdateSource() {
  const refresh = useRefreshSources();
  return useMutation({
    mutationFn: (input: { id: string; update: SourceUpdate }) =>
      api.patch<Source>(`/admin/sources/${input.id}`, input.update),
    onSettled: refresh,
  });
}

export function useDeleteSource() {
  const refresh = useRefreshSources();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/sources/${id}`),
    onSettled: refresh,
  });
}

export function useCheckSource() {
  const refresh = useRefreshSources();
  return useMutation({
    mutationFn: (id: string) => api.post<SourceCheck>(`/admin/sources/${id}/check`),
    onSettled: refresh,
  });
}

export function useWebhookSecret() {
  const refresh = useRefreshSources();
  return useMutation({
    mutationFn: (id: string) => api.post<WebhookSecretCreated>(`/admin/sources/${id}/webhook-secret`),
    onSettled: refresh,
  });
}

export function usePeople(q: string) {
  return useQuery({
    queryKey: adminKeys.people(q),
    queryFn: ({ signal }) => api.get<{ items: Person[] }>("/admin/people", { q }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useUpdatePerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; update: PersonUpdate }) =>
      api.patch<Person>(`/admin/people/${input.id}`, input.update),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin", "people"] }),
        client.invalidateQueries({ queryKey: ["me"] }),
      ]),
  });
}

/** Removes a person: the logs keep them as REMOVED_PERSON_NAME (`@connector/shared/api/users`). */
export function useRemovePerson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/people/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: ["admin", "people"] }),
  });
}

/** Service tokens (bots) and SCIM tokens (identity systems) work the same way. */
export type TokenKind = "service" | "scim";

/** Service or SCIM tokens; `poll` refreshes them while it returns an interval (e.g. waiting for a first use). */
export function useAdminTokens(
  kind: TokenKind,
  options: { poll?: (items: ServiceToken[]) => number | false } = {},
) {
  const { poll } = options;
  return useQuery({
    queryKey: adminKeys.tokens(kind),
    queryFn: ({ signal }) => api.get<{ items: ServiceToken[] }>(`/admin/${kind}-tokens`, undefined, signal),
    refetchInterval: poll ? (query) => poll(query.state.data?.items ?? []) : undefined,
  });
}

export function useCreateAdminToken(kind: TokenKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TokenCreate) => api.post<TokenCreated>(`/admin/${kind}-tokens`, input),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: adminKeys.tokens(kind) }),
        client.invalidateQueries({ queryKey: adminKeys.status }),
      ]),
  });
}

export function useRevokeAdminToken(kind: TokenKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/${kind}-tokens/${id}`),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: adminKeys.tokens(kind) }),
        client.invalidateQueries({ queryKey: adminKeys.status }),
      ]),
  });
}

export function useGroups() {
  return useQuery({
    queryKey: adminKeys.groups,
    queryFn: ({ signal }) => api.get<{ items: Group[] }>("/admin/groups", undefined, signal),
  });
}

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.post<Group>("/admin/groups", input),
    onSettled: () => client.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useDeleteGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/groups/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: adminKeys.groups }),
  });
}

export function useDirectory() {
  return useQuery({
    queryKey: adminKeys.directory,
    queryFn: ({ signal }) => api.get<DirectoryStatus>("/admin/directory", undefined, signal),
  });
}

export function useSyncDirectory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DirectoryStatus>("/admin/directory/sync"),
    onSuccess: (status) => client.setQueryData(adminKeys.directory, status),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: adminKeys.groups }),
        client.invalidateQueries({ queryKey: ["admin", "people"] }),
        client.invalidateQueries({ queryKey: adminKeys.status }),
      ]),
  });
}

export function useActivity(q: string, limit: number, offset: number) {
  return useQuery({
    queryKey: adminKeys.activity(q, limit, offset),
    queryFn: ({ signal }) =>
      api.get<{ items: ActivityEntry[]; total: number }>("/admin/activity", { q, limit, offset }, signal),
    placeholderData: keepPreviousData,
  });
}

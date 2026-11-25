import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectedApp,
  ConnectInfo,
  Token,
  TokenCreate,
  TokenCreated,
} from "@connector/shared/api/tokens";
import type { Link } from "@connector/shared/api/sources";
import type { About } from "@connector/shared/api/users";
import { api } from "@/lib/api";

export const settingsKeys = {
  tokens: ["tokens"] as const,
  connectedApps: ["connected-apps"] as const,
  connectInfo: ["connect-info"] as const,
  about: ["about"] as const,
};

/** The version that runs (the commit of the image), for the About card. */
export function useAbout() {
  return useQuery({ queryKey: settingsKeys.about, queryFn: () => api.get<About>("/about") });
}

export function useTokens() {
  return useQuery({
    queryKey: settingsKeys.tokens,
    queryFn: ({ signal }) => api.get<{ items: Token[] }>("/tokens", undefined, signal),
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TokenCreate) => api.post<TokenCreated>("/tokens", input),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tokens/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.tokens }),
  });
}

export function useConnectedApps() {
  return useQuery({
    queryKey: settingsKeys.connectedApps,
    queryFn: ({ signal }) => api.get<{ items: ConnectedApp[] }>("/connected-apps", undefined, signal),
  });
}

export function useDisconnectApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/connected-apps/${id}`),
    onSettled: () => client.invalidateQueries({ queryKey: settingsKeys.connectedApps }),
  });
}

export function useConnectInfo() {
  return useQuery({
    queryKey: settingsKeys.connectInfo,
    queryFn: ({ signal }) => api.get<ConnectInfo>("/connect-info", undefined, signal),
    staleTime: Infinity,
  });
}

export const linkKeys = { links: ["links"] as const };

/** The person's linked accounts at sources (Handbook). */
export function useLinks() {
  return useQuery({
    queryKey: linkKeys.links,
    queryFn: ({ signal }) => api.get<{ items: Link[] }>("/links", undefined, signal),
  });
}

/** Starts linking: the browser goes to the source's consent screen and comes back to Settings. */
export function useStartLink() {
  return useMutation({
    mutationFn: (slug: string) => api.post<{ authorizeUrl: string }>(`/links/${encodeURIComponent(slug)}`),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });
}

export function useUnlink() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => api.delete(`/links/${encodeURIComponent(slug)}`),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: linkKeys.links }),
        client.invalidateQueries({ queryKey: ["sources"] }),
      ]),
  });
}

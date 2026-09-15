import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken, type AircraftDetail, type AuditEntry, type Defect, type DefectHistory, type FleetRow, type ManagedUser, type Overview, type PredictiveAlert, type Station } from './api';

export const useOverview = () =>
  useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview') });

export const useFleet = () =>
  useQuery({ queryKey: ['fleet'], queryFn: () => api<{ aircraft: FleetRow[] }>('/fleet') });

export const useAircraft = (registration: string | null) =>
  useQuery({
    queryKey: ['aircraft', registration],
    queryFn: () => api<{ aircraft: AircraftDetail }>(`/fleet/${registration}`),
    enabled: Boolean(registration),
  });

export const useStations = () =>
  useQuery({ queryKey: ['stations'], queryFn: () => api<{ stations: Station[] }>('/stations') });

export const useDefects = (filters: { status?: string; registration?: string; ataChapter?: string; overdue?: string }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const qs = params.toString();
  return useQuery({
    queryKey: ['defects', qs],
    queryFn: () => api<{ defects: Defect[] }>(`/defects${qs ? `?${qs}` : ''}`),
  });
};

export const useDefectHistory = (year?: number) =>
  useQuery({
    queryKey: ['history', year ?? 'current'],
    queryFn: () => api<DefectHistory>(`/history${year ? `?year=${year}` : ''}`),
  });

export const useUsers = (enabled = true) =>
  useQuery({ queryKey: ['users'], queryFn: () => api<{ users: ManagedUser[] }>('/auth/users'), enabled });

/**
 * The audit trail is the one list that pages: it grows without bound, so it is fetched a
 * page at a time rather than whole like every other collection here.
 */
export const useAudit = (filters: { entityType?: string; action?: string }, enabled = true) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const qs = params.toString();

  return useInfiniteQuery({
    queryKey: ['audit', qs],
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(qs);
      if (pageParam) page.set('cursor', pageParam);
      const query = page.toString();
      return api<{ entries: AuditEntry[]; nextCursor: string | null }>(`/audit${query ? `?${query}` : ''}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
};

export const useAlerts = () =>
  useQuery({ queryKey: ['alerts'], queryFn: () => api<{ alerts: PredictiveAlert[] }>('/alerts') });

/**
 * Subscribes to the server event stream and invalidates affected queries so the
 * board reflects changes made by other controllers without a manual refresh.
 */
export function useLiveStream() {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const source = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
    const refresh = (keys: string[]) => () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    };

    source.addEventListener('connected', () => setConnected(true));
    source.addEventListener('defect.created', refresh(['defects', 'fleet', 'overview']));
    source.addEventListener('defect.updated', refresh(['defects', 'fleet', 'overview', 'aircraft']));
    source.addEventListener('aircraft.created', refresh(['fleet', 'overview', 'stations']));
    source.addEventListener('aircraft.updated', refresh(['fleet', 'overview', 'aircraft', 'stations']));
    source.addEventListener('aircraft.deleted', refresh(['fleet', 'overview', 'aircraft', 'stations', 'alerts']));
    source.addEventListener('station.created', refresh(['stations', 'overview']));
    source.addEventListener('station.updated', refresh(['stations', 'overview']));
    source.addEventListener('station.deleted', refresh(['stations', 'overview', 'fleet']));
    source.addEventListener('impediment.updated', refresh(['stations', 'overview']));
    source.addEventListener('alert.created', refresh(['alerts', 'fleet', 'overview']));
    source.addEventListener('alert.updated', refresh(['alerts', 'fleet', 'overview']));
    source.addEventListener('alert.deleted', refresh(['alerts', 'fleet', 'overview', 'aircraft']));
    source.addEventListener('history.updated', refresh(['history', 'overview']));
    source.addEventListener('user.created', refresh(['users']));
    source.addEventListener('user.updated', refresh(['users']));
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [queryClient]);

  return connected;
}

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken, type AircraftDetail, type Defect, type FleetRow, type Overview, type PredictiveAlert, type Station } from './api';

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

export const useDefects = (filters: { status?: string; registration?: string; ataChapter?: string }) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const qs = params.toString();
  return useQuery({
    queryKey: ['defects', qs],
    queryFn: () => api<{ defects: Defect[] }>(`/defects${qs ? `?${qs}` : ''}`),
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
    source.addEventListener('aircraft.updated', refresh(['fleet', 'overview', 'aircraft', 'stations']));
    source.addEventListener('station.updated', refresh(['stations', 'overview']));
    source.addEventListener('impediment.updated', refresh(['stations', 'overview']));
    source.addEventListener('alert.updated', refresh(['alerts', 'fleet', 'overview']));
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [queryClient]);

  return connected;
}

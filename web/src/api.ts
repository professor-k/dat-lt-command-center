const TOKEN_KEY = 'datlt.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable - session stays in memory only */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent('datlt:unauthorized'));
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.message ?? body.error ?? `Request failed (${response.status})`, response.status);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/* ---------- Domain types ---------- */

export type Role = 'ADMIN' | 'ENGINEER' | 'VIEWER';
export type OperationalStatus = 'ACTIVE' | 'AOG' | 'MAINTENANCE' | 'STORED';
export type DefectCategory = 'CRITICAL' | 'CAT_A' | 'CAT_B' | 'CAT_C' | 'CAT_D';
export type DefectStatus = 'OPEN' | 'DEFERRED' | 'CLOSED';
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type NetworkStatus = 'OPTIMAL' | 'DEGRADED' | 'CRITICAL';
export type ComplianceStatus = 'PASSED' | 'PASSED_MINOR' | 'PENDING_REVIEW' | 'FAILED';
export type ImpedimentStatus = 'OPEN' | 'MITIGATED' | 'RESOLVED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt?: string | null;
}

/** A user as the admin list returns them — fuller than the session user from /login. */
export interface ManagedUser extends User {
  active: boolean;
  createdAt: string;
}

export interface PredictiveAlert {
  id: string;
  component: string;
  ataChapter: string;
  severity: AlertSeverity;
  dueInDays: number;
  confidence?: number;
  recommendation: string;
  acknowledged?: boolean;
  aircraft?: { registration: string; model?: string };
}

export interface FleetRow {
  id: string;
  registration: string;
  model: string;
  operationalStatus: OperationalStatus;
  flightHours: number;
  cycles: number;
  station: { code: string; city: string } | null;
  openDefectCount: number;
  worstDefectCategory: DefectCategory | null;
  predictiveAlert: PredictiveAlert | null;
}

export interface Defect {
  id: string;
  reference: string;
  ataChapter: string;
  title: string;
  description?: string | null;
  category: DefectCategory;
  status: DefectStatus;
  repetitive: boolean;
  raisedAt: string;
  dueAt?: string | null;
  closedAt?: string | null;
  aircraft?: { registration: string; model?: string; station?: { code: string } | null };
  raisedBy?: { name: string } | null;
  closedBy?: { name: string } | null;
}

export interface AircraftDetail {
  id: string;
  registration: string;
  model: string;
  operationalStatus: OperationalStatus;
  flightHours: number;
  cycles: number;
  station: { code: string; city: string } | null;
  defects: Defect[];
  alerts: PredictiveAlert[];
}

export interface Impediment {
  id: string;
  category: string;
  description: string;
  status: ImpedimentStatus;
  openedAt: string;
  resolvedAt?: string | null;
}

export interface Station {
  id: string;
  code: string;
  city: string;
  country: string;
  networkStatus: NetworkStatus;
  complianceStatus: ComplianceStatus;
  lastAuditAt?: string | null;
  requiredAction?: string | null;
  impediments: Impediment[];
  aircraft: { registration: string; model?: string; operationalStatus: OperationalStatus }[];
}

export interface DefectHistory {
  year: number;
  months: { month: number; count: number }[];
  total: number;
}

export interface Overview {
  year: number;
  openDefects: number;
  criticalDefects: number;
  projectedDefects: number;
  criticalPredictiveRisk: {
    component: string;
    ataChapter: string;
    severity: AlertSeverity;
    dueInDays: number;
    confidence: number;
    recommendation: string;
    registration: string;
    repetitive: boolean;
    repetitionCount: number;
  } | null;
  fleet: { total: number; aog: number; availability: number };
  network: { stations: number; degraded: number };
  defectTrend: { month: number; count: number }[];
  ataBreakdown: { ataChapter: string; count: number }[];
}

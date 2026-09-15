import type { ReactNode } from 'react';
import type {
  AlertSeverity,
  ComplianceStatus,
  DefectCategory,
  DefectStatus,
  ImpedimentStatus,
  NetworkStatus,
  OperationalStatus,
} from '../api';

type Tone = 'active' | 'aog' | 'warning' | 'idle';

const TONE_CLASS: Record<Tone, string> = {
  active: 'active-state',
  aog: 'aog-state',
  warning: 'warning-state',
  idle: 'idle-state',
};

export function StatusIndicator({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={TONE_CLASS[tone]}>
      <span className="status-dot" />
      <span className="status-text">{label}</span>
    </span>
  );
}

const OPERATIONAL: Record<OperationalStatus, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'active', label: 'Active' },
  AOG: { tone: 'aog', label: 'AOG' },
  MAINTENANCE: { tone: 'warning', label: 'Maintenance' },
  STORED: { tone: 'idle', label: 'Stored' },
};

export const OperationalStatusCell = ({ status }: { status: OperationalStatus }) => (
  <StatusIndicator {...OPERATIONAL[status]} />
);

const NETWORK: Record<NetworkStatus, { tone: Tone; label: string }> = {
  OPTIMAL: { tone: 'active', label: 'Optimal' },
  DEGRADED: { tone: 'warning', label: 'Degraded' },
  CRITICAL: { tone: 'aog', label: 'Critical' },
};

export const NetworkStatusCell = ({ status }: { status: NetworkStatus }) => (
  <StatusIndicator {...NETWORK[status]} />
);

export const COMPLIANCE_LABEL: Record<ComplianceStatus, string> = {
  PASSED: 'Passed',
  PASSED_MINOR: 'Passed (1 Minor)',
  PENDING_REVIEW: 'Pending Review',
  FAILED: 'Failed',
};

export const CATEGORY_LABEL: Record<DefectCategory, string> = {
  CRITICAL: 'Critical',
  CAT_A: 'Cat A',
  CAT_B: 'Cat B',
  CAT_C: 'Cat C',
  CAT_D: 'Cat D',
};

export const DEFECT_STATUS_LABEL: Record<DefectStatus, string> = {
  OPEN: 'Open',
  DEFERRED: 'Deferred',
  CLOSED: 'Closed',
};

export const IMPEDIMENT_STATUS_LABEL: Record<ImpedimentStatus, string> = {
  OPEN: 'Open',
  MITIGATED: 'Mitigated',
  RESOLVED: 'Resolved',
};

export function CategoryTag({ category }: { category: DefectCategory }) {
  const tone = category === 'CRITICAL' ? 'critical' : category === 'CAT_A' ? 'warning' : 'neutral';
  return <span className={`tag ${tone}`}>{CATEGORY_LABEL[category]}</span>;
}

export function SeverityTag({ severity }: { severity: AlertSeverity }) {
  const tone = severity === 'CRITICAL' ? 'critical' : severity === 'WARNING' ? 'warning' : 'neutral';
  return <span className={`tag ${tone}`}>{severity}</span>;
}

/** Predictive alert wording used across the telemetry table and drawers. */
export function alertText(alert: { component: string; dueInDays: number } | null): string {
  if (!alert) return 'No prediction';
  if (alert.dueInDays <= 0) return `${alert.component} (Change Now)`;
  if (alert.dueInDays === 1) return `${alert.component} (1 Day)`;
  return `${alert.component} (${alert.dueInDays} Days)`;
}

export function TableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="panel-head" style={{ marginBottom: 0 }}>
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="drawer-sub">{subtitle}</p> : null}
          </div>
          <button className="btn small ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export const formatDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const relativeDays = (value?: string | null) => {
  if (!value) return null;
  const diff = Math.round((new Date(value).getTime() - Date.now()) / 86_400_000);
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'due today';
  return `${diff}d left`;
};

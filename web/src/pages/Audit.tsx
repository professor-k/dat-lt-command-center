import { useState } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import type { AuditEntityType, AuditEntry } from '../api';
import { useAudit } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge, ROLE_LABEL } from '../components/Shell';
import { TableSkeleton } from '../components/ui';

const ENTITY_TYPES: { value: AuditEntityType | ''; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'Aircraft', label: 'Aircraft' },
  { value: 'Defect', label: 'Defects' },
  { value: 'Station', label: 'Stations' },
  { value: 'PredictiveAlert', label: 'Predictions' },
  { value: 'DefectHistory', label: 'Baseline' },
  { value: 'User', label: 'Accounts' },
];

/** A removal or deactivation reads as a stronger event than an edit. */
const DESTRUCTIVE = /\.(deleted|closed|withdrawn|deactivated|cleared|password_reset)$/;

const timestamp = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function AuditPage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { can } = useAuth();
  const isAdmin = can('ADMIN');
  const [entityType, setEntityType] = useState('');

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useAudit({ entityType }, isAdmin);

  if (!isAdmin) return <Navigate to="/fleet" replace />;

  const entries: AuditEntry[] = data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Change <span>History</span>
          </h1>
          <p className="header-sub">
            {isLoading ? 'Loading the trail' : `${entries.length} change${entries.length === 1 ? '' : 's'} shown, newest first`}
          </p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="table-container">
        <div className="panel-head">
          <div className="filters">
            <select value={entityType} onChange={(e) => setEntityType(e.target.value)} aria-label="Filter by record type">
              {ENTITY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <span className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>
            Every change, and who made it
          </span>
        </div>

        {isLoading ? (
          <TableSkeleton rows={6} />
        ) : entries.length === 0 ? (
          <p className="empty">Nothing recorded yet for this filter.</p>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>What Changed</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {timestamp(entry.createdAt)}
                      </td>
                      <td>
                        {entry.actorEmail}
                        <span className="sub">{ROLE_LABEL[entry.actorRole]}</span>
                      </td>
                      <td>
                        <span className={`tag ${DESTRUCTIVE.test(entry.action) ? 'critical' : 'neutral'}`}>
                          {entry.action}
                        </span>
                      </td>
                      <td>{entry.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {hasNextPage ? (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
                <button className="btn ghost" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                  {isFetchingNextPage ? 'Loading' : 'Load older changes'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

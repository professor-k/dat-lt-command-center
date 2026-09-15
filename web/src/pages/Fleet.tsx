import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api, type FleetRow, type OperationalStatus } from '../api';
import { useAircraft, useFleet, useOverview } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import {
  CATEGORY_LABEL,
  CategoryTag,
  Drawer,
  OperationalStatusCell,
  SeverityTag,
  TableSkeleton,
  alertText,
  formatDate,
  relativeDays,
} from '../components/ui';

const STATUS_OPTIONS: OperationalStatus[] = ['ACTIVE', 'AOG', 'MAINTENANCE', 'STORED'];

export function FleetPage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { data: overview, isLoading: overviewLoading } = useOverview();
  const { data: fleet, isLoading: fleetLoading } = useFleet();
  const [selected, setSelected] = useState<string | null>(null);

  const risk = overview?.criticalPredictiveRisk;
  const trend = overview?.defectTrend.filter((t) => t.count > 0) ?? [];
  const peak = Math.max(1, ...trend.map((t) => t.count));

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Strategic <span>Fleet Overview</span>
          </h1>
          <p className="header-sub">
            {overview
              ? `${overview.fleet.total} aircraft · ${overview.fleet.availability}% availability · ${overview.fleet.aog} AOG`
              : 'Loading fleet telemetry'}
          </p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <h3>Open Defects (Current)</h3>
          <p className="value">
            <strong>{overviewLoading ? '—' : overview?.openDefects}</strong>
          </p>
          <p className="stat-foot">{overview?.criticalDefects ?? 0} critical / no-go</p>
        </div>

        <div className="stat-card gold">
          <h3>Projected Defects ({overview?.year ?? ''})</h3>
          <p className="value gold">
            <strong>{overviewLoading ? '—' : overview?.projectedDefects}</strong>
          </p>
          <div className="spark" aria-hidden="true">
            {trend.map((t) => (
              <span key={t.month} style={{ height: `${(t.count / peak) * 100}%` }} />
            ))}
          </div>
        </div>

        <div className={`stat-card${risk?.severity === 'CRITICAL' ? ' danger' : ''}`}>
          <h3>Critical Predictive Risk</h3>
          {risk ? (
            <p className="value compact">
              {risk.component}
              <small>
                ATA {risk.ataChapter} {risk.repetitive ? '(Repetitive)' : `· ${risk.registration}`}
              </small>
            </p>
          ) : (
            <p className="value compact">
              No active risk<small>All predictions acknowledged</small>
            </p>
          )}
          {risk ? (
            <p className="stat-foot">
              {Math.round(risk.confidence * 100)}% confidence ·{' '}
              {risk.dueInDays <= 0 ? 'action now' : `${risk.dueInDays} days`}
            </p>
          ) : null}
        </div>
      </div>

      <div className="table-container">
        <div className="panel-head">
          <h3>Live Aircraft Telemetry</h3>
          <span className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>
            Select an aircraft for the full technical record
          </span>
        </div>

        {fleetLoading ? (
          <TableSkeleton rows={4} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Aircraft</th>
                  <th>Location</th>
                  <th>Operational Status</th>
                  <th>Open Defects</th>
                  <th>Predictive Alert</th>
                </tr>
              </thead>
              <tbody>
                {fleet?.aircraft.map((row) => (
                  <FleetTableRow key={row.id} row={row} onSelect={() => setSelected(row.registration)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected ? <AircraftDrawer registration={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

function FleetTableRow({ row, onSelect }: { row: FleetRow; onSelect: () => void }) {
  const alert = row.predictiveAlert;
  const alertStyle =
    alert?.severity === 'CRITICAL'
      ? { color: 'var(--status-aog)', fontWeight: 500 }
      : alert?.severity === 'WARNING'
        ? { color: 'var(--text-main)' }
        : { color: 'var(--text-muted)' };

  return (
    <tr className="clickable" onClick={onSelect}>
      <td>{row.registration}</td>
      <td className="muted">{row.station?.code ?? '—'}</td>
      <td>
        <OperationalStatusCell status={row.operationalStatus} />
      </td>
      <td>
        {row.openDefectCount}
        {row.worstDefectCategory ? (
          <span className="sub">({CATEGORY_LABEL[row.worstDefectCategory]})</span>
        ) : null}
      </td>
      <td style={alertStyle}>{alertText(alert)}</td>
    </tr>
  );
}

function AircraftDrawer({ registration, onClose }: { registration: string; onClose: () => void }) {
  const { data, isLoading } = useAircraft(registration);
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const editable = can('ADMIN', 'ENGINEER');

  const setStatus = useMutation({
    mutationFn: (operationalStatus: OperationalStatus) =>
      api(`/fleet/${registration}`, { method: 'PATCH', body: JSON.stringify({ operationalStatus }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['aircraft'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  const closeDefect = useMutation({
    mutationFn: (id: string) => api(`/defects/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'CLOSED' }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['aircraft'] });
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['defects'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  const aircraft = data?.aircraft;
  const openDefects = aircraft?.defects.filter((d) => d.status !== 'CLOSED') ?? [];

  return (
    <Drawer
      title={registration}
      subtitle={aircraft ? `${aircraft.model} · ${aircraft.station?.city ?? 'Unassigned'}` : 'Loading'}
      onClose={onClose}
    >
      {isLoading || !aircraft ? (
        <TableSkeleton rows={5} />
      ) : (
        <>
          <dl className="spec-grid">
            <div className="spec">
              <dt>Status</dt>
              <dd>
                <OperationalStatusCell status={aircraft.operationalStatus} />
              </dd>
            </div>
            <div className="spec">
              <dt>Station</dt>
              <dd>{aircraft.station?.code ?? '—'}</dd>
            </div>
            <div className="spec">
              <dt>Flight Hours</dt>
              <dd>{aircraft.flightHours.toLocaleString('en-GB')}</dd>
            </div>
            <div className="spec">
              <dt>Cycles</dt>
              <dd>{aircraft.cycles.toLocaleString('en-GB')}</dd>
            </div>
          </dl>

          {editable ? (
            <div className="list-block">
              <h4>Set Operational Status</h4>
              <div className="record-actions">
                {STATUS_OPTIONS.map((status) => (
                  <button
                    key={status}
                    className={`btn small${status === aircraft.operationalStatus ? ' primary' : ''}`}
                    disabled={setStatus.isPending || status === aircraft.operationalStatus}
                    onClick={() => setStatus.mutate(status)}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="list-block">
            <h4>Predictive Alerts</h4>
            {aircraft.alerts.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                No predictions on file.
              </p>
            ) : (
              aircraft.alerts.map((alert) => (
                <div className="record" key={alert.id}>
                  <div className="record-top">
                    <span className="title">
                      {alert.component} <span className="sub">ATA {alert.ataChapter}</span>
                    </span>
                    <SeverityTag severity={alert.severity} />
                  </div>
                  <p className="meta" style={{ margin: 0 }}>
                    {alert.recommendation}
                  </p>
                  <p className="meta" style={{ margin: '6px 0 0' }}>
                    {alert.dueInDays <= 0 ? 'Action now' : `${alert.dueInDays} days`} ·{' '}
                    {Math.round((alert.confidence ?? 0) * 100)}% confidence
                    {alert.acknowledged ? ' · acknowledged' : ''}
                  </p>
                </div>
              ))
            )}
          </div>

          <div className="list-block">
            <h4>Open Defects ({openDefects.length})</h4>
            {openDefects.length === 0 ? (
              <p className="muted" style={{ fontSize: 13 }}>
                Technical log clear.
              </p>
            ) : (
              openDefects.map((defect) => (
                <div className="record" key={defect.id}>
                  <div className="record-top">
                    <span className="title">{defect.title}</span>
                    <CategoryTag category={defect.category} />
                  </div>
                  <p className="meta" style={{ margin: 0 }}>
                    {defect.reference} · ATA {defect.ataChapter} · raised {formatDate(defect.raisedAt)}
                    {defect.dueAt ? ` · ${relativeDays(defect.dueAt)}` : ''}
                    {defect.repetitive ? ' · repetitive' : ''}
                  </p>
                  {editable ? (
                    <div className="record-actions">
                      <button
                        className="btn small"
                        disabled={closeDefect.isPending}
                        onClick={() => closeDefect.mutate(defect.id)}
                      >
                        Close defect
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </Drawer>
  );
}

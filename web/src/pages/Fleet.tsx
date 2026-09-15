import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api, type FleetRow, type OperationalStatus } from '../api';
import { useAircraft, useDefectHistory, useFleet, useOverview, useStations } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import {
  CATEGORY_LABEL,
  CategoryTag,
  Drawer,
  Modal,
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
  const { can } = useAuth();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingBaseline, setEditingBaseline] = useState(false);
  const editable = can('ADMIN', 'ENGINEER');

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
          {editable ? (
            <button className="btn small ghost" style={{ marginTop: 14 }} onClick={() => setEditingBaseline(true)}>
              Edit baseline
            </button>
          ) : null}
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
          {editable ? (
            <button className="btn gold" onClick={() => setAdding(true)}>
              Add aircraft
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>
              Select an aircraft for the full technical record
            </span>
          )}
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
      {adding ? <AddAircraftModal onClose={() => setAdding(false)} /> : null}
      {editingBaseline ? (
        <DefectBaselineModal year={overview?.year ?? new Date().getFullYear()} onClose={() => setEditingBaseline(false)} />
      ) : null}
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
  const { data: stations } = useStations();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const editable = can('ADMIN', 'ENGINEER');
  const removable = can('ADMIN');

  const setStatus = useMutation({
    mutationFn: (operationalStatus: OperationalStatus) =>
      api(`/fleet/${registration}`, { method: 'PATCH', body: JSON.stringify({ operationalStatus }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['aircraft'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  const move = useMutation({
    mutationFn: (stationCode: string | null) =>
      api(`/fleet/${registration}`, { method: 'PATCH', body: JSON.stringify({ stationCode }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['aircraft'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/fleet/${registration}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
    onError: (e: Error) => setRemoveError(e.message),
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

              <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
                <label htmlFor="ac-station">Based At</label>
                <select
                  id="ac-station"
                  value={aircraft.station?.code ?? ''}
                  disabled={move.isPending}
                  onChange={(e) => move.mutate(e.target.value || null)}
                >
                  <option value="">Unassigned</option>
                  {stations?.stations.map((st) => (
                    <option key={st.id} value={st.code}>
                      {st.code} — {st.city}
                    </option>
                  ))}
                </select>
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

          {removable ? (
            <div className="list-block">
              <h4>Remove From Fleet</h4>
              {removeError ? <p className="error-msg">{removeError}</p> : null}
              <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>
                Only an airframe with no technical record can be removed. Retire an aircraft that has
                history by setting it <strong>STORED</strong> instead.
              </p>
              <div className="record-actions">
                <button className="btn small danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  {remove.isPending ? 'Removing' : `Remove ${registration}`}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Drawer>
  );
}

function AddAircraftModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: stations } = useStations();
  const [form, setForm] = useState({
    registration: '',
    model: 'ATR 72-600',
    operationalStatus: 'ACTIVE' as OperationalStatus,
    stationCode: '',
    flightHours: '0',
    cycles: '0',
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api('/fleet', {
        method: 'POST',
        body: JSON.stringify({
          registration: form.registration.trim().toUpperCase(),
          model: form.model.trim(),
          operationalStatus: form.operationalStatus,
          ...(form.stationCode ? { stationCode: form.stationCode } : {}),
          flightHours: Number(form.flightHours) || 0,
          cycles: Number(form.cycles) || 0,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const valid = /^[A-Za-z0-9-]{3,10}$/.test(form.registration.trim()) && form.model.trim().length >= 2;

  return (
    <Modal title="Add aircraft to fleet" onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="ac-reg">Registration</label>
        <input
          id="ac-reg"
          value={form.registration}
          maxLength={10}
          placeholder="LY-DAT"
          onChange={(e) => setForm({ ...form, registration: e.target.value.toUpperCase() })}
        />
      </div>

      <div className="field">
        <label htmlFor="ac-model">Type</label>
        <input
          id="ac-model"
          value={form.model}
          placeholder="ATR 72-600"
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ac-base">Based At</label>
        <select
          id="ac-base"
          value={form.stationCode}
          onChange={(e) => setForm({ ...form, stationCode: e.target.value })}
        >
          <option value="">Unassigned</option>
          {stations?.stations.map((st) => (
            <option key={st.id} value={st.code}>
              {st.code} — {st.city}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="ac-status">Operational Status</label>
        <select
          id="ac-status"
          value={form.operationalStatus}
          onChange={(e) => setForm({ ...form, operationalStatus: e.target.value as OperationalStatus })}
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="ac-hours">Flight Hours</label>
        <input
          id="ac-hours"
          type="number"
          min={0}
          step="0.1"
          value={form.flightHours}
          onChange={(e) => setForm({ ...form, flightHours: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="ac-cycles">Cycles</label>
        <input
          id="ac-cycles"
          type="number"
          min={0}
          step="1"
          value={form.cycles}
          onChange={(e) => setForm({ ...form, cycles: e.target.value })}
        />
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding' : 'Add aircraft'}
        </button>
      </div>
    </Modal>
  );
}

const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The monthly defect counts the year-end projection is built from. They are
 * reference figures the reliability desk maintains, not something the defect
 * log derives, so they are edited by hand here.
 */
function DefectBaselineModal({ year, onClose }: { year: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useDefectHistory(year);
  const [draft, setDraft] = useState<Record<number, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored: Record<number, string> = {};
  for (const m of data?.months ?? []) stored[m.month] = String(m.count);
  const values = draft ?? stored;

  const save = useMutation({
    mutationFn: async () => {
      const changed = MONTH_LABEL.map((_, i) => i + 1).filter(
        (month) => (values[month] ?? '') !== (stored[month] ?? ''),
      );
      for (const month of changed) {
        const raw = values[month] ?? '';
        if (raw === '') {
          await api(`/history/${year}/${month}`, { method: 'DELETE' });
        } else {
          await api('/history', {
            method: 'PUT',
            body: JSON.stringify({ year, month, count: Number(raw) }),
          });
        }
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const total = MONTH_LABEL.reduce((sum, _, i) => sum + (Number(values[i + 1]) || 0), 0);

  return (
    <Modal title={`Defect baseline — ${year}`} onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}
      <p className="muted" style={{ fontSize: 13, margin: '0 0 18px' }}>
        Monthly totals feeding the year-end projection. Leave a month blank to remove it.
      </p>

      {isLoading ? (
        <TableSkeleton rows={4} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 12 }}>
          {MONTH_LABEL.map((label, i) => {
            const month = i + 1;
            return (
              <div className="field" key={label} style={{ marginBottom: 0 }}>
                <label htmlFor={`hist-${month}`}>{label}</label>
                <input
                  id={`hist-${month}`}
                  type="number"
                  min={0}
                  step="1"
                  value={values[month] ?? ''}
                  onChange={(e) => setDraft({ ...values, [month]: e.target.value })}
                />
              </div>
            );
          })}
        </div>
      )}

      <p className="muted" style={{ fontSize: 13, marginTop: 18 }}>
        Baseline total: <strong>{total}</strong>
      </p>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={save.isPending || isLoading} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving' : 'Save baseline'}
        </button>
      </div>
    </Modal>
  );
}

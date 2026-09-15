import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api, type AlertSeverity } from '../api';
import { useAlerts, useFleet, useOverview } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import { Modal, SeverityTag, TableSkeleton } from '../components/ui';

export function PredictivePage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { data, isLoading } = useAlerts();
  const { data: overview } = useOverview();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const editable = can('ADMIN', 'ENGINEER');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['alerts'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
    void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    void queryClient.invalidateQueries({ queryKey: ['aircraft'] });
  };

  const acknowledge = useMutation({
    mutationFn: ({ id, acknowledged }: { id: string; acknowledged: boolean }) =>
      api(`/alerts/${id}`, { method: 'PATCH', body: JSON.stringify({ acknowledged }) }),
    onSuccess: refresh,
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/alerts/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const alerts = data?.alerts ?? [];
  const ataPeak = Math.max(1, ...(overview?.ataBreakdown.map((a) => a.count) ?? [1]));

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Predictive <span>Risk Model</span>
          </h1>
          <p className="header-sub">
            {alerts.filter((a) => !a.acknowledged).length} open predictions · component reliability trend
          </p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="table-container">
        <div className="panel-head">
          <h3>Component Predictions</h3>
          {editable ? (
            <button className="btn gold" onClick={() => setAdding(true)}>
              Add prediction
            </button>
          ) : null}
        </div>

        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : alerts.length === 0 ? (
          <p className="empty">No predictions on file.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Aircraft</th>
                  <th>ATA</th>
                  <th>Severity</th>
                  <th>Horizon</th>
                  <th>Confidence</th>
                  <th>Recommendation</th>
                  {editable ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert) => (
                  <tr key={alert.id} style={alert.acknowledged ? { opacity: 0.55 } : undefined}>
                    <td>{alert.component}</td>
                    <td>{alert.aircraft?.registration}</td>
                    <td className="muted">{alert.ataChapter}</td>
                    <td>
                      <SeverityTag severity={alert.severity} />
                    </td>
                    <td>{alert.dueInDays <= 0 ? 'Change now' : `${alert.dueInDays} days`}</td>
                    <td className="muted">{Math.round((alert.confidence ?? 0) * 100)}%</td>
                    <td className="muted">{alert.recommendation}</td>
                    {editable ? (
                      <td>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="btn small"
                            disabled={acknowledge.isPending}
                            onClick={() =>
                              acknowledge.mutate({ id: alert.id, acknowledged: !alert.acknowledged })
                            }
                          >
                            {alert.acknowledged ? 'Reopen' : 'Acknowledge'}
                          </button>
                          <button
                            className="btn small danger"
                            disabled={withdraw.isPending}
                            onClick={() => withdraw.mutate(alert.id)}
                          >
                            Withdraw
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="table-container">
        <div className="panel-head">
          <h3>Open Defects by ATA Chapter</h3>
        </div>
        {overview?.ataBreakdown.length ? (
          <div style={{ display: 'grid', gap: 14 }}>
            {overview.ataBreakdown.map((row) => (
              <div key={row.ataChapter} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span style={{ width: 70, fontSize: 13, letterSpacing: 1 }}>ATA {row.ataChapter}</span>
                <div style={{ flex: 1, height: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 6 }}>
                  <div
                    style={{
                      width: `${(row.count / ataPeak) * 100}%`,
                      height: '100%',
                      borderRadius: 6,
                      background: 'linear-gradient(90deg, var(--accent-purple), var(--accent-gold))',
                    }}
                  />
                </div>
                <span className="muted" style={{ width: 24, textAlign: 'right', fontSize: 13 }}>
                  {row.count}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="empty">No open defects to profile.</p>
        )}
      </div>

      {adding ? <AddPredictionModal onClose={() => setAdding(false)} onSaved={refresh} /> : null}
    </section>
  );
}

const SEVERITIES: AlertSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

/**
 * Predictions are entered by the reliability desk rather than derived, so the
 * horizon and confidence are the engineer's own working figures.
 */
function AddPredictionModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data: fleet } = useFleet();
  const registrations = fleet?.aircraft.map((a) => a.registration) ?? [];
  const [form, setForm] = useState({
    registration: '',
    component: '',
    ataChapter: '',
    severity: 'WARNING' as AlertSeverity,
    dueInDays: '30',
    confidence: '80',
    recommendation: '',
  });
  const [error, setError] = useState<string | null>(null);

  const registration = form.registration || registrations[0] || '';

  const create = useMutation({
    mutationFn: () =>
      api('/alerts', {
        method: 'POST',
        body: JSON.stringify({
          registration,
          component: form.component.trim(),
          ataChapter: form.ataChapter.trim(),
          severity: form.severity,
          dueInDays: Number(form.dueInDays) || 0,
          confidence: Math.min(1, Math.max(0, (Number(form.confidence) || 0) / 100)),
          recommendation: form.recommendation.trim(),
        }),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const valid =
    registration &&
    form.component.trim().length >= 2 &&
    form.ataChapter.trim() &&
    form.recommendation.trim().length >= 3;

  return (
    <Modal title="Add component prediction" onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="pr-ac">Aircraft</label>
        <select id="pr-ac" value={registration} onChange={(e) => setForm({ ...form, registration: e.target.value })}>
          {registrations.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="pr-component">Component</label>
        <input
          id="pr-component"
          value={form.component}
          placeholder="Hydraulic Pump"
          onChange={(e) => setForm({ ...form, component: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="pr-ata">ATA Chapter</label>
        <input
          id="pr-ata"
          value={form.ataChapter}
          maxLength={4}
          placeholder="29"
          onChange={(e) => setForm({ ...form, ataChapter: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="pr-severity">Severity</label>
        <select
          id="pr-severity"
          value={form.severity}
          onChange={(e) => setForm({ ...form, severity: e.target.value as AlertSeverity })}
        >
          {SEVERITIES.map((sv) => (
            <option key={sv} value={sv}>
              {sv}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="pr-horizon">Horizon (days, 0 = act now)</label>
        <input
          id="pr-horizon"
          type="number"
          min={0}
          step="1"
          value={form.dueInDays}
          onChange={(e) => setForm({ ...form, dueInDays: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="pr-confidence">Confidence (%)</label>
        <input
          id="pr-confidence"
          type="number"
          min={0}
          max={100}
          step="1"
          value={form.confidence}
          onChange={(e) => setForm({ ...form, confidence: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="pr-rec">Recommendation</label>
        <textarea
          id="pr-rec"
          rows={3}
          value={form.recommendation}
          placeholder="Schedule pump replacement at next MXP night stop"
          onChange={(e) => setForm({ ...form, recommendation: e.target.value })}
        />
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Adding' : 'Add prediction'}
        </button>
      </div>
    </Modal>
  );
}

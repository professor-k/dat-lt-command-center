import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api, type DefectCategory, type DefectStatus } from '../api';
import { useDefects, useFleet } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import {
  CATEGORY_LABEL,
  CategoryTag,
  DEFECT_STATUS_LABEL,
  Modal,
  TableSkeleton,
  formatDate,
  relativeDays,
} from '../components/ui';

const CATEGORIES: DefectCategory[] = ['CRITICAL', 'CAT_A', 'CAT_B', 'CAT_C', 'CAT_D'];

export function DefectsPage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('');
  const [registration, setRegistration] = useState<string>('');
  const [raising, setRaising] = useState(false);

  const { data: fleet } = useFleet();
  const { data, isLoading } = useDefects({ status, registration });
  const editable = can('ADMIN', 'ENGINEER');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['defects'] });
    void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const update = useMutation({
    mutationFn: ({ id, next }: { id: string; next: DefectStatus }) =>
      api(`/defects/${id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) }),
    onSuccess: refresh,
  });

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Technical <span>Defect Log</span>
          </h1>
          <p className="header-sub">MEL-categorised snags across the fleet, newest first</p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="table-container">
        <div className="panel-head">
          <div className="filters">
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="DEFERRED">Deferred</option>
              <option value="CLOSED">Closed</option>
            </select>
            <select
              value={registration}
              onChange={(e) => setRegistration(e.target.value)}
              aria-label="Filter by aircraft"
            >
              <option value="">All aircraft</option>
              {fleet?.aircraft.map((a) => (
                <option key={a.id} value={a.registration}>
                  {a.registration}
                </option>
              ))}
            </select>
          </div>
          {editable ? (
            <button className="btn gold" onClick={() => setRaising(true)}>
              Raise defect
            </button>
          ) : null}
        </div>

        {isLoading ? (
          <TableSkeleton rows={6} />
        ) : data?.defects.length === 0 ? (
          <p className="empty">No defects match the current filter.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Aircraft</th>
                  <th>ATA</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Due</th>
                  {editable ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {data?.defects.map((defect) => (
                  <tr key={defect.id}>
                    <td>{defect.reference}</td>
                    <td>{defect.aircraft?.registration}</td>
                    <td className="muted">{defect.ataChapter}</td>
                    <td>
                      {defect.title}
                      {defect.repetitive ? <span className="sub">repetitive</span> : null}
                    </td>
                    <td>
                      <CategoryTag category={defect.category} />
                    </td>
                    <td className={defect.status === 'CLOSED' ? 'muted' : ''}>
                      {DEFECT_STATUS_LABEL[defect.status]}
                    </td>
                    <td className="muted">
                      {defect.status === 'CLOSED'
                        ? `closed ${formatDate(defect.closedAt)}`
                        : (relativeDays(defect.dueAt) ?? '—')}
                    </td>
                    {editable ? (
                      <td>
                        {defect.status === 'CLOSED' ? (
                          <button
                            className="btn small ghost"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ id: defect.id, next: 'OPEN' })}
                          >
                            Reopen
                          </button>
                        ) : (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              className="btn small"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ id: defect.id, next: 'CLOSED' })}
                            >
                              Close
                            </button>
                            {defect.status === 'OPEN' ? (
                              <button
                                className="btn small ghost"
                                disabled={update.isPending}
                                onClick={() => update.mutate({ id: defect.id, next: 'DEFERRED' })}
                              >
                                Defer
                              </button>
                            ) : null}
                          </div>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {raising ? (
        <RaiseDefectModal
          registrations={fleet?.aircraft.map((a) => a.registration) ?? []}
          onClose={() => setRaising(false)}
          onSaved={refresh}
        />
      ) : null}
    </section>
  );
}

function RaiseDefectModal({
  registrations,
  onClose,
  onSaved,
}: {
  registrations: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    registration: registrations[0] ?? '',
    ataChapter: '',
    title: '',
    description: '',
    category: 'CAT_C' as DefectCategory,
    repetitive: false,
  });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api('/defects', { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const valid = form.registration && form.ataChapter.trim() && form.title.trim().length >= 3;

  return (
    <Modal title="Raise technical defect" onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}

      <div className="field">
        <label htmlFor="def-ac">Aircraft</label>
        <select
          id="def-ac"
          value={form.registration}
          onChange={(e) => setForm({ ...form, registration: e.target.value })}
        >
          {registrations.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="def-ata">ATA Chapter</label>
        <input
          id="def-ata"
          value={form.ataChapter}
          maxLength={4}
          placeholder="36"
          onChange={(e) => setForm({ ...form, ataChapter: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="def-title">Snag</label>
        <input
          id="def-title"
          value={form.title}
          placeholder="Bleed air valve slow response"
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="def-desc">Details</label>
        <textarea
          id="def-desc"
          rows={3}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="def-cat">MEL Category</label>
        <select
          id="def-cat"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value as DefectCategory })}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>

      <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
        <input
          type="checkbox"
          checked={form.repetitive}
          style={{ width: 'auto' }}
          onChange={(e) => setForm({ ...form, repetitive: e.target.checked })}
        />
        Repetitive snag (feeds the predictive model)
      </label>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Raising' : 'Raise defect'}
        </button>
      </div>
    </Modal>
  );
}

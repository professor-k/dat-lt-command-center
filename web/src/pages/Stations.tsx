import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api, type Station } from '../api';
import { useStations } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import {
  COMPLIANCE_LABEL,
  Drawer,
  IMPEDIMENT_STATUS_LABEL,
  Modal,
  NetworkStatusCell,
  TableSkeleton,
  formatDate,
} from '../components/ui';

export function StationsPage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { data, isLoading } = useStations();
  const [selected, setSelected] = useState<string | null>(null);

  const stations = data?.stations ?? [];
  const station = stations.find((s) => s.code === selected) ?? null;

  return (
    <section className="tab-section">
      <div className="topline">
        <div>
          <h1 className="header-title">
            Station <span>Operations Hub</span>
          </h1>
          <p className="header-sub">
            {stations.length} outstations · {stations.filter((s) => s.networkStatus !== 'OPTIMAL').length} requiring
            attention
          </p>
        </div>
        <LiveBadge connected={connected} />
      </div>

      <div className="table-container">
        <div className="panel-head">
          <h3>Italian Network Status</h3>
          <span className="muted" style={{ fontSize: 12, letterSpacing: 1 }}>
            Select a station to manage impediments
          </span>
        </div>

        {isLoading ? (
          <TableSkeleton rows={4} />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Station ID</th>
                  <th>Network Status</th>
                  <th>Active Impediments</th>
                  <th>Compliance (Audit)</th>
                  <th>Required Action</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => setSelected(s.code)}>
                    <td>
                      {s.code}
                      <span className="sub">{s.city}</span>
                    </td>
                    <td>
                      <NetworkStatusCell status={s.networkStatus} />
                    </td>
                    <td>
                      {s.impediments.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        s.impediments[0].description.split(' - ')[0]
                      )}
                      {s.impediments.length > 1 ? <span className="sub">+{s.impediments.length - 1}</span> : null}
                    </td>
                    <td className="muted">{COMPLIANCE_LABEL[s.complianceStatus]}</td>
                    <td>{s.requiredAction ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {station ? <StationDrawer station={station} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}

function StationDrawer({ station, onClose }: { station: Station; onClose: () => void }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const editable = can('ADMIN', 'ENGINEER');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  };

  const resolve = useMutation({
    mutationFn: (id: string) =>
      api(`/stations/impediments/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'RESOLVED' }) }),
    onSuccess: refresh,
  });

  const setNetworkStatus = useMutation({
    mutationFn: (networkStatus: Station['networkStatus']) =>
      api(`/stations/${station.code}`, { method: 'PATCH', body: JSON.stringify({ networkStatus }) }),
    onSuccess: refresh,
  });

  return (
    <Drawer title={station.code} subtitle={`${station.city}, ${station.country}`} onClose={onClose}>
      <dl className="spec-grid">
        <div className="spec">
          <dt>Network</dt>
          <dd>
            <NetworkStatusCell status={station.networkStatus} />
          </dd>
        </div>
        <div className="spec">
          <dt>Compliance</dt>
          <dd style={{ fontSize: 14 }}>{COMPLIANCE_LABEL[station.complianceStatus]}</dd>
        </div>
        <div className="spec">
          <dt>Last Audit</dt>
          <dd style={{ fontSize: 14 }}>{formatDate(station.lastAuditAt)}</dd>
        </div>
        <div className="spec">
          <dt>Aircraft On Station</dt>
          <dd>{station.aircraft.length}</dd>
        </div>
      </dl>

      {station.requiredAction ? (
        <div className="list-block">
          <h4>Required Action</h4>
          <div className="record">
            <span className="title">{station.requiredAction}</span>
          </div>
        </div>
      ) : null}

      {editable ? (
        <div className="list-block">
          <h4>Set Network Status</h4>
          <div className="record-actions">
            {(['OPTIMAL', 'DEGRADED', 'CRITICAL'] as const).map((status) => (
              <button
                key={status}
                className={`btn small${status === station.networkStatus ? ' primary' : ''}`}
                disabled={setNetworkStatus.isPending || status === station.networkStatus}
                onClick={() => setNetworkStatus.mutate(status)}
              >
                {status}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="list-block">
        <div className="panel-head" style={{ marginBottom: 14 }}>
          <h4 style={{ margin: 0 }}>Active Impediments ({station.impediments.length})</h4>
          {editable ? (
            <button className="btn small" onClick={() => setAdding(true)}>
              Log impediment
            </button>
          ) : null}
        </div>

        {station.impediments.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            Station operating without impediments.
          </p>
        ) : (
          station.impediments.map((imp) => (
            <div className="record" key={imp.id}>
              <div className="record-top">
                <span className="title">{imp.description}</span>
                <span className="tag neutral">{imp.category}</span>
              </div>
              <p className="meta" style={{ margin: 0 }}>
                {IMPEDIMENT_STATUS_LABEL[imp.status]} · opened {formatDate(imp.openedAt)}
              </p>
              {editable ? (
                <div className="record-actions">
                  <button className="btn small" disabled={resolve.isPending} onClick={() => resolve.mutate(imp.id)}>
                    Mark resolved
                  </button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      <div className="list-block">
        <h4>Aircraft On Station</h4>
        {station.aircraft.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No aircraft currently assigned.
          </p>
        ) : (
          station.aircraft.map((a) => (
            <div className="record" key={a.registration}>
              <div className="record-top">
                <span className="title">{a.registration}</span>
                <span className="tag neutral">{a.operationalStatus}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {adding ? <ImpedimentModal stationCode={station.code} onClose={() => setAdding(false)} onSaved={refresh} /> : null}
    </Drawer>
  );
}

function ImpedimentModal({
  stationCode,
  onClose,
  onSaved,
}: {
  stationCode: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState('Consumables');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api(`/stations/${stationCode}/impediments`, {
        method: 'POST',
        body: JSON.stringify({ category, description }),
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal title={`Log impediment · ${stationCode}`} onClose={onClose}>
      {error ? <p className="error-msg">{error}</p> : null}
      <div className="field">
        <label htmlFor="imp-category">Category</label>
        <select id="imp-category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {['Consumables', 'Manpower', 'Tooling', 'Facility', 'Documentation'].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="imp-desc">Description</label>
        <textarea
          id="imp-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="B1 Engineer sick leave - night shift uncovered"
        />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={description.trim().length < 3 || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Saving' : 'Log impediment'}
        </button>
      </div>
    </Modal>
  );
}

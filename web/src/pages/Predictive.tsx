import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../api';
import { useAlerts, useOverview } from '../hooks';
import { useAuth } from '../auth';
import { LiveBadge } from '../components/Shell';
import { SeverityTag, TableSkeleton } from '../components/ui';

export function PredictivePage() {
  const { connected } = useOutletContext<{ connected: boolean }>();
  const { data, isLoading } = useAlerts();
  const { data: overview } = useOverview();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const editable = can('ADMIN', 'ENGINEER');

  const acknowledge = useMutation({
    mutationFn: ({ id, acknowledged }: { id: string; acknowledged: boolean }) =>
      api(`/alerts/${id}`, { method: 'PATCH', body: JSON.stringify({ acknowledged }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      void queryClient.invalidateQueries({ queryKey: ['fleet'] });
    },
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
                        <button
                          className="btn small"
                          disabled={acknowledge.isPending}
                          onClick={() =>
                            acknowledge.mutate({ id: alert.id, acknowledged: !alert.acknowledged })
                          }
                        >
                          {alert.acknowledged ? 'Reopen' : 'Acknowledge'}
                        </button>
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
    </section>
  );
}

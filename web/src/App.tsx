import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/Login';
import { FleetPage } from './pages/Fleet';
import { StationsPage } from './pages/Stations';
import { DefectsPage } from './pages/Defects';
import { PredictivePage } from './pages/Predictive';

export function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="login-wrap">
        <p className="muted" style={{ letterSpacing: 3, textTransform: 'uppercase', fontSize: 12 }}>
          Establishing uplink
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/fleet" element={<FleetPage />} />
        <Route path="/stations" element={<StationsPage />} />
        <Route path="/defects" element={<DefectsPage />} />
        <Route path="/predictive" element={<PredictivePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/fleet" replace />} />
    </Routes>
  );
}

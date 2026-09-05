import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@cerebro/shared';
import { AuthProvider, useAuth } from '@/auth/AuthContext';
import { AppShell } from '@/components/AppShell';
import { Brand } from '@/components/Brand';
import { Login } from '@/pages/Login';
import { Consent } from '@/pages/Consent';
import { Setup } from '@/pages/Setup';
import { Dashboard } from '@/pages/Dashboard';
import { Panel } from '@/pages/Panel';
import { Viewscreen } from '@/pages/Viewscreen';
import { Account } from '@/pages/Account';
import { OverviewResources } from '@/pages/OverviewResources';
import { ConnectorsList } from '@/pages/connectors/ConnectorsList';
import { ConnectorSetup } from '@/pages/connectors/ConnectorSetup';
import { ConnectorDetail } from '@/pages/connectors/ConnectorDetail';
import { Console } from '@/pages/connectors/Console';
import { MonitorsList } from '@/pages/monitors/MonitorsList';
import { MonitorForm } from '@/pages/monitors/MonitorForm';
import { MonitorDetail } from '@/pages/monitors/MonitorDetail';
import { Users } from '@/pages/Users';
import { Logs } from '@/pages/Logs';
import { About } from '@/pages/About';
import { SettingsHome } from '@/pages/settings/SettingsHome';
import { Authentication } from '@/pages/settings/Authentication';
import { Email } from '@/pages/settings/Email';
import { Notifications } from '@/pages/settings/Notifications';
import { ApiTokens } from '@/pages/settings/ApiTokens';
import { OAuthClients } from '@/pages/settings/OAuthClients';

function FullscreenBrand() {
  return (
    <div className="min-h-screen grid place-items-center cerebro-aurora">
      <div className="animate-pulse"><Brand className="scale-150" /></div>
    </div>
  );
}

function RequirePerm({ perm, children }: { perm: Permission; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(perm)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenBrand />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to={`/login`} state={{ from: location }} replace />;
  return <AppShell>{children}</AppShell>;
}

/** Authenticated, but rendered fullscreen without the AppShell chrome (kiosk). */
function ProtectedBare({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  const location = useLocation();
  if (loading) return <FullscreenBrand />;
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to={`/login`} state={{ from: location }} replace />;
  return <>{children}</>;
}

function Gate({ children }: { children: React.ReactNode }) {
  // For /login and /setup: redirect away if already resolved.
  const { user, loading, needsSetup } = useAuth();
  if (loading) return <FullscreenBrand />;
  if (!needsSetup && user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Router() {
  const { needsSetup, loading } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Gate>{needsSetup && !loading ? <Navigate to="/setup" replace /> : <Login />}</Gate>} />
      <Route path="/setup" element={<Gate><Setup /></Gate>} />
      {/* OAuth consent — standalone; the page itself bounces to login if unauthenticated. */}
      <Route path="/consent" element={<Consent />} />

      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/panel" element={<ProtectedBare><Panel /></ProtectedBare>} />
      <Route path="/viewscreen" element={<Protected><RequirePerm perm="connectors:read"><Viewscreen /></RequirePerm></Protected>} />
      <Route path="/overview/:kind" element={<Protected><RequirePerm perm="connectors:read"><OverviewResources /></RequirePerm></Protected>} />
      <Route path="/connectors" element={<Protected><RequirePerm perm="connectors:read"><ConnectorsList /></RequirePerm></Protected>} />
      <Route path="/connectors/new/:connectorId" element={<Protected><RequirePerm perm="connectors:write"><ConnectorSetup /></RequirePerm></Protected>} />
      <Route path="/connectors/:id" element={<Protected><RequirePerm perm="connectors:read"><ConnectorDetail /></RequirePerm></Protected>} />
      <Route path="/connectors/:id/edit" element={<Protected><RequirePerm perm="connectors:write"><ConnectorSetup /></RequirePerm></Protected>} />
      <Route path="/connectors/:id/console/:kind/:resourceId" element={<Protected><RequirePerm perm="connectors:action"><Console /></RequirePerm></Protected>} />
      <Route path="/monitors" element={<Protected><RequirePerm perm="monitors:read"><MonitorsList /></RequirePerm></Protected>} />
      <Route path="/monitors/new" element={<Protected><RequirePerm perm="monitors:write"><MonitorForm /></RequirePerm></Protected>} />
      <Route path="/monitors/:id" element={<Protected><RequirePerm perm="monitors:read"><MonitorDetail /></RequirePerm></Protected>} />
      <Route path="/monitors/:id/edit" element={<Protected><RequirePerm perm="monitors:write"><MonitorForm /></RequirePerm></Protected>} />
      <Route path="/users" element={<Protected><RequirePerm perm="users:read"><Users /></RequirePerm></Protected>} />
      <Route path="/logs" element={<Protected><RequirePerm perm="logs:read"><Logs /></RequirePerm></Protected>} />
      <Route path="/settings" element={<Protected><RequirePerm perm="settings:read"><SettingsHome /></RequirePerm></Protected>} />
      <Route path="/settings/authentication" element={<Protected><RequirePerm perm="settings:read"><Authentication /></RequirePerm></Protected>} />
      <Route path="/settings/email" element={<Protected><RequirePerm perm="settings:read"><Email /></RequirePerm></Protected>} />
      <Route path="/settings/notifications" element={<Protected><RequirePerm perm="settings:read"><Notifications /></RequirePerm></Protected>} />
      <Route path="/settings/api-tokens" element={<Protected><RequirePerm perm="settings:read"><ApiTokens /></RequirePerm></Protected>} />
      <Route path="/settings/oauth-clients" element={<Protected><RequirePerm perm="settings:read"><OAuthClients /></RequirePerm></Protected>} />
      <Route path="/account" element={<Protected><Account /></Protected>} />
      <Route path="/about" element={<Protected><About /></Protected>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Router />
      </BrowserRouter>
    </AuthProvider>
  );
}

import { useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  authProvider: string;
  roleSlug: string;
  roleName: string;
  disabled: boolean;
  lastLoginAt: string | null;
}
interface Role { slug: string; name: string }

export function Users() {
  const { can, user: me } = useAuth();
  const writable = can('users:write');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ displayName: '', email: '', password: '', roleSlug: 'viewer' });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setUsers(await api.get<UserRow[]>('/api/users'));
    setRoles(await api.get<Role[]>('/api/roles'));
  }
  useEffect(() => { void load(); }, []);

  async function changeRole(id: string, roleSlug: string) {
    await api.patch(`/api/users/${id}/role`, { roleSlug });
    await load();
  }
  async function toggleDisabled(u: UserRow) {
    await api.patch(`/api/users/${u.id}/disabled`, { disabled: !u.disabled });
    await load();
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/users', form);
      setShowCreate(false);
      setForm({ displayName: '', email: '', password: '', roleSlug: 'viewer' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create user');
    }
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Manage who can access Cerebro and what they can do."
        actions={writable && (
          <Button onClick={() => setShowCreate((s) => !s)}>
            <UserPlus className="h-4 w-4" /> Add user
          </Button>
        )}
      />

      {showCreate && (
        <Card className="mb-6">
          <CardContent className="pt-6">
            {error && <p className="text-sm text-destructive mb-3">{error}</p>}
            <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Display name</Label>
                <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
              </div>
              <div>
                <Label>Email</Label>
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div>
                <Label>Temporary password</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={10} />
              </div>
              <div>
                <Label>Role</Label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
                  value={form.roleSlug}
                  onChange={(e) => setForm({ ...form, roleSlug: e.target.value })}
                >
                  {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
                </select>
              </div>
              <div className="sm:col-span-2">
                <Button type="submit">Create user</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground border-b border-border">
              <tr>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Auth</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                {writable && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.displayName}</div>
                    <div className="text-muted-foreground text-xs">{u.email}</div>
                  </td>
                  <td className="px-4 py-3 capitalize text-muted-foreground">{u.authProvider}</td>
                  <td className="px-4 py-3">
                    {writable && u.id !== me?.id ? (
                      <select
                        className="h-8 rounded-md border border-input bg-background/60 px-2 text-sm"
                        value={u.roleSlug}
                        onChange={(e) => changeRole(u.id, e.target.value)}
                      >
                        {roles.map((r) => <option key={r.slug} value={r.slug}>{r.name}</option>)}
                      </select>
                    ) : (
                      u.roleName
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.disabled
                      ? <span className="text-destructive">Disabled</span>
                      : <span className="text-emerald-400">Active</span>}
                  </td>
                  {writable && (
                    <td className="px-4 py-3 text-right">
                      {u.id !== me?.id && (
                        <Button variant="ghost" size="sm" onClick={() => toggleDisabled(u)}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}

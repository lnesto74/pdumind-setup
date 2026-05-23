import React, { useState, useEffect, useCallback } from 'react';
import SupportDebugTab from './SupportDebugTab';
import HubSharePanel from './HubSharePanel';
import PasswordInput from './PasswordInput';

const API_BASE = '';

function getToken() {
  return localStorage.getItem('pdumind_token') || '';
}

function authHeaders() {
  return { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' };
}

const fieldClass = 'px-3 py-2 rounded-lg bg-[#0f172a] border border-[#233544] text-white text-xs focus:border-[#00E5FF] focus:outline-none w-full';
const pwFieldClass = `${fieldClass} pr-9`;

export default function AdminPanel({ onClose, initialTab = 'share' }) {
  const [tab, setTab] = useState(initialTab);
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', display_name: '' });
  const [showAddUser, setShowAddUser] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({ username: '', display_name: '', password: '' });
  const [error, setError] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/users`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
    } catch {}
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/access-log?limit=200`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (tab === 'users') fetchUsers();
    if (tab === 'logs') fetchLogs();
  }, [tab, fetchUsers, fetchLogs]);

  const handleAddUser = async (e) => {
    e.preventDefault();
    setError('');
    if (!newUser.username || !newUser.password) {
      setError('Username and password required');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/auth/users`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(newUser),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed'); return; }
      setNewUser({ username: '', password: '', display_name: '' });
      setShowAddUser(false);
      fetchUsers();
    } catch { setError('Server error'); }
  };

  const startEditUser = (u) => {
    setEditingUser(u.id);
    setEditForm({ username: u.username, display_name: u.display_name || u.username, password: '' });
    setError('');
  };

  const cancelEditUser = () => {
    setEditingUser(null);
    setEditForm({ username: '', display_name: '', password: '' });
    setError('');
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    setError('');
    if (!editForm.username.trim()) {
      setError('Username is required');
      return;
    }
    try {
      const payload = {
        username: editForm.username.trim(),
        display_name: editForm.display_name.trim() || editForm.username.trim(),
      };
      if (editForm.password) payload.password = editForm.password;

      const res = await fetch(`${API_BASE}/api/auth/users/${editingUser}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to update user'); return; }
      cancelEditUser();
      fetchUsers();
    } catch { setError('Server error'); }
  };

  const handleDeleteUser = async (userId, username) => {
    if (!confirm(`Delete user "${username}"?`)) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/users/${userId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.ok) fetchUsers();
    } catch {}
  };

  const ACTION_LABELS = {
    login: { icon: 'login', color: 'text-emerald-400', label: 'Login' },
    logout: { icon: 'logout', color: 'text-slate-400', label: 'Logout' },
    login_failed: { icon: 'error', color: 'text-red-400', label: 'Failed Login' },
    login_blocked_inactive: { icon: 'block', color: 'text-red-400', label: 'Blocked (inactive)' },
    password_changed: { icon: 'vpn_key', color: 'text-amber-400', label: 'Password Changed' },
    account_setup_completed: { icon: 'manage_accounts', color: 'text-emerald-400', label: 'Account Setup' },
  };

  const actionLabel = (action) => {
    if (ACTION_LABELS[action]) return ACTION_LABELS[action];
    if (action.startsWith('username_changed:')) {
      return { icon: 'badge', color: 'text-amber-400', label: 'Username Changed' };
    }
    if (action.startsWith('updated_user:')) {
      return { icon: 'edit', color: 'text-[#00E5FF]', label: 'User Updated' };
    }
    if (action.startsWith('created_user:')) {
      return { icon: 'person_add', color: 'text-emerald-400', label: 'User Created' };
    }
    if (action.startsWith('deleted_user:')) {
      return { icon: 'delete', color: 'text-red-400', label: 'User Deleted' };
    }
    return { icon: 'info', color: 'text-slate-400', label: action };
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className={`w-full ${tab === 'debug' || tab === 'share' ? 'max-w-3xl' : 'max-w-2xl'} max-h-[80vh] bg-[#0f172a] border border-[#233544] rounded-2xl shadow-2xl overflow-hidden`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#233544]">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <span className="material-icons-outlined text-[#00E5FF]">admin_panel_settings</span>
            Administration
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <span className="material-icons-outlined">close</span>
          </button>
        </div>

        <div className="flex flex-wrap gap-1 px-6 pt-4">
          {[
            { id: 'share', label: 'Share', icon: 'share' },
            { id: 'users', label: 'Users', icon: 'people' },
            { id: 'logs', label: 'Access Log', icon: 'history' },
            { id: 'debug', label: 'Support Debug', icon: 'bug_report' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs transition-colors ${
                tab === t.id ? 'bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              <span className="material-icons-outlined text-sm">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {tab === 'share' && <HubSharePanel />}
          {tab === 'debug' && <SupportDebugTab />}

          {tab === 'users' && (
            <div className="space-y-3">
              <div className="flex justify-between items-center mb-4">
                <span className="text-xs text-slate-500">{users.length} user{users.length !== 1 ? 's' : ''}</span>
                <button
                  onClick={() => { setShowAddUser(!showAddUser); cancelEditUser(); }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-[#00E5FF]/10 text-[#00E5FF] border border-[#00E5FF]/30 hover:bg-[#00E5FF]/20 transition-colors"
                >
                  <span className="material-icons-outlined text-sm">person_add</span>
                  Add User
                </button>
              </div>

              {showAddUser && (
                <form onSubmit={handleAddUser} className="p-4 rounded-xl bg-[#0B1120] border border-[#233544] mb-4">
                  {error && <p className="text-red-400 text-xs mb-2">{error}</p>}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input
                      type="text" placeholder="Username" value={newUser.username}
                      onChange={e => setNewUser({ ...newUser, username: e.target.value })}
                      className={fieldClass}
                    />
                    <PasswordInput
                      placeholder="Password"
                      value={newUser.password}
                      onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                      inputClassName={pwFieldClass}
                    />
                    <input
                      type="text" placeholder="Display Name" value={newUser.display_name}
                      onChange={e => setNewUser({ ...newUser, display_name: e.target.value })}
                      className={fieldClass}
                    />
                  </div>
                  <button type="submit" className="mt-3 px-4 py-1.5 rounded-lg bg-[#00E5FF] text-[#0B1120] font-bold text-xs">
                    Create
                  </button>
                </form>
              )}

              {users.map(u => (
                <div key={u.id} className="rounded-xl bg-[#0B1120] border border-[#233544] overflow-hidden">
                  {editingUser === u.id ? (
                    <form onSubmit={handleUpdateUser} className="p-4 space-y-3">
                      {error && <p className="text-red-400 text-xs">{error}</p>}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] text-slate-500 uppercase mb-1">Username</label>
                          <input
                            type="text"
                            value={editForm.username}
                            onChange={e => setEditForm({ ...editForm, username: e.target.value })}
                            className={fieldClass}
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-500 uppercase mb-1">Display Name</label>
                          <input
                            type="text"
                            value={editForm.display_name}
                            onChange={e => setEditForm({ ...editForm, display_name: e.target.value })}
                            className={fieldClass}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 uppercase mb-1">New Password</label>
                        <PasswordInput
                          placeholder="Leave blank to keep current password"
                          value={editForm.password}
                          onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                          inputClassName={pwFieldClass}
                        />
                      </div>
                      <div className="flex gap-2">
                        <button type="submit" className="px-4 py-1.5 rounded-lg bg-[#00E5FF] text-[#0B1120] font-bold text-xs">
                          Save
                        </button>
                        <button type="button" onClick={cancelEditUser} className="px-4 py-1.5 rounded-lg text-xs text-slate-400 border border-[#233544] hover:text-white">
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#233544] flex items-center justify-center">
                          <span className="material-icons-outlined text-slate-400 text-sm">person</span>
                        </div>
                        <div>
                          <p className="text-sm text-white">{u.display_name || u.username}</p>
                          <p className="text-[10px] text-slate-500">@{u.username} &middot; {u.created_at?.split('T')[0] || u.created_at?.split(' ')[0]}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {!u.is_active && (
                          <span className="text-[9px] text-red-400 px-2 py-0.5 rounded bg-red-500/15 border border-red-500/30">disabled</span>
                        )}
                        <button
                          onClick={() => startEditUser(u)}
                          className="text-slate-600 hover:text-[#00E5FF] transition-colors"
                          title="Edit user"
                        >
                          <span className="material-icons-outlined text-sm">edit</span>
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u.id, u.username)}
                          className="text-slate-600 hover:text-red-400 transition-colors"
                          title="Delete user"
                        >
                          <span className="material-icons-outlined text-sm">delete</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'logs' && (
            <div className="space-y-1">
              <div className="flex justify-between items-center mb-4">
                <span className="text-xs text-slate-500">Last {logs.length} entries</span>
                <button onClick={fetchLogs} className="text-xs text-slate-500 hover:text-[#00E5FF] transition-colors">
                  <span className="material-icons-outlined text-sm align-middle mr-1">refresh</span>Refresh
                </button>
              </div>
              <div className="rounded-xl bg-[#0B1120] border border-[#233544] overflow-hidden">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-[#233544] text-slate-500">
                      <th className="text-left px-4 py-2">Time</th>
                      <th className="text-left px-4 py-2">User</th>
                      <th className="text-left px-4 py-2">Action</th>
                      <th className="text-left px-4 py-2">IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(log => {
                      const info = actionLabel(log.action);
                      return (
                        <tr key={log.id} className="border-b border-[#233544]/50 hover:bg-[#161E2E]">
                          <td className="px-4 py-2 text-slate-400">{log.timestamp?.replace('T', ' ').slice(0, 19)}</td>
                          <td className="px-4 py-2 text-white">{log.username}</td>
                          <td className="px-4 py-2">
                            <span className={`flex items-center gap-1 ${info.color}`}>
                              <span className="material-icons-outlined text-xs">{info.icon}</span>
                              {info.label}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-slate-500">{log.ip}</td>
                        </tr>
                      );
                    })}
                    {logs.length === 0 && (
                      <tr><td colSpan="4" className="px-4 py-8 text-center text-slate-600">No log entries</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

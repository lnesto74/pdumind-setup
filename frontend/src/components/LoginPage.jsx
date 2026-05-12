import React, { useState } from 'react';

const API_BASE = '';

export default function LoginPage({ onLogin, version }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePwError, setChangePwError] = useState('');
  const [tempToken, setTempToken] = useState('');
  const [tempUser, setTempUser] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return;
      }
      if (data.user.must_change_pw) {
        setTempToken(data.token);
        setTempUser(data.user);
        setShowChangePw(true);
        setLoading(false);
        return;
      }
      onLogin(data.user, data.token);
    } catch {
      setError('Cannot reach server');
    }
    setLoading(false);
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setChangePwError('');
    if (newPassword !== confirmPassword) {
      setChangePwError('Passwords do not match');
      return;
    }
    if (newPassword.length < 4) {
      setChangePwError('Password must be at least 4 characters');
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tempToken}`,
        },
        body: JSON.stringify({ current_password: password, new_password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setChangePwError(data.error || 'Failed to change password');
        return;
      }
      onLogin({ ...tempUser, must_change_pw: false }, tempToken);
    } catch {
      setChangePwError('Cannot reach server');
    }
  };

  return (
    <div className="min-h-screen bg-[#0B1120] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <img src="/logo/pdumind-logo-2.png" alt="PDUMind" className="h-12 mx-auto mb-6" />
          <p className="text-slate-500 text-xs tracking-widest uppercase">Power Distribution Intelligence</p>
        </div>

        {!showChangePw ? (
          /* Login Form */
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="p-6 rounded-xl bg-[#0f172a] border border-[#233544]">
              <h2 className="text-sm font-bold text-white mb-5 flex items-center gap-2">
                <span className="material-icons-outlined text-[#00E5FF] text-lg">lock</span>
                Sign In
              </h2>

              {error && (
                <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
                  <span className="material-icons-outlined text-sm">error</span>
                  {error}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B1120] border border-[#233544] text-white text-sm focus:border-[#00E5FF] focus:outline-none transition-colors"
                    placeholder="admin"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B1120] border border-[#233544] text-white text-sm focus:border-[#00E5FF] focus:outline-none transition-colors"
                    placeholder="••••••"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-5 py-2.5 rounded-lg bg-[#00E5FF] text-[#0B1120] font-bold text-sm uppercase tracking-wider hover:bg-[#00d4eb] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </div>
          </form>
        ) : (
          /* Change Password Form */
          <form onSubmit={handleChangePassword} className="space-y-5">
            <div className="p-6 rounded-xl bg-[#0f172a] border border-[#233544]">
              <h2 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                <span className="material-icons-outlined text-amber-400 text-lg">vpn_key</span>
                Change Password
              </h2>
              <p className="text-xs text-slate-500 mb-5">
                You must set a new password before continuing.
              </p>

              {changePwError && (
                <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
                  <span className="material-icons-outlined text-sm">error</span>
                  {changePwError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B1120] border border-[#233544] text-white text-sm focus:border-[#00E5FF] focus:outline-none transition-colors"
                    placeholder="••••••"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 uppercase tracking-wider mb-1.5">Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B1120] border border-[#233544] text-white text-sm focus:border-[#00E5FF] focus:outline-none transition-colors"
                    placeholder="••••••"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full mt-5 py-2.5 rounded-lg bg-[#00E5FF] text-[#0B1120] font-bold text-sm uppercase tracking-wider hover:bg-[#00d4eb] transition-colors"
              >
                Set Password & Continue
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Footer */}
      <div className="mt-10 text-center">
        <p className="text-[10px] text-slate-700 font-mono">Powered by Aility Pte Ltd</p>
        <p className="text-[10px] text-slate-700 font-mono mt-0.5">PDUMind {version}</p>
      </div>
    </div>
  );
}

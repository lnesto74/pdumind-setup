import React, { useState } from 'react';

/** Password field with optional show/hide toggle. */
export default function PasswordInput({
  value,
  onChange,
  placeholder = 'Password',
  className = '',
  inputClassName = '',
  showToggle = true,
  required = false,
  autoFocus = false,
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${className}`}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        className={`w-full pr-9 ${inputClassName}`}
      />
      {showToggle && (
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-[#00E5FF] transition-colors"
          title={visible ? 'Hide password' : 'Show password'}
          tabIndex={-1}
        >
          <span className="material-icons-outlined text-sm">{visible ? 'visibility_off' : 'visibility'}</span>
        </button>
      )}
    </div>
  );
}

import React from 'react';
import { usePDUContext } from '../context/PDUContext';

const Sidebar = () => {
  const { pduList, activePdu, setActivePdu, addPdu } = usePDUContext();

  const handleAdd = () => {
    const ip = prompt('Enter PDU IP address');
    if (!ip) return;
    const port = prompt('Enter SNMP port', '161');
    addPdu(ip, port);
  };

  return (
    <aside className="sidebar">

      <h2 className="sidebar-title">PDUs</h2>
      <ul className="sidebar-list">
        {pduList.map((p, idx) => (
          <li
            key={idx}
            className={`sidebar-item ${activePdu?.ip === p.ip && activePdu?.port === p.port ? 'active' : ''}`}
            onClick={() => setActivePdu(idx)}
          >
            {p.ip}:{p.port}
          </li>
        ))}
      </ul>
      <button className="sidebar-add" onClick={handleAdd}>+ Add PDU</button>
      <style>
        {`
          .sidebar-add {
            margin-top: 1rem;
            background: var(--color-primary);
            color: #fff;
            padding: 0.3rem 0.6rem;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            width: 100%;
          }
          .sidebar-add:hover {
            background: var(--color-primary-light);
          }
        `}
      </style>
    </aside>
  );
};

export default Sidebar;

export function pickNum(results, ...names) {
  if (!results?.length) return null;
  for (const n of names) {
    const it = results.find((r) => r.name === n);
    if (it?.value != null) {
      const m = String(it.value).replace(/"/g, '').trim().match(/^-?[\d.]+/);
      if (m) return parseFloat(m[0]);
    }
  }
  return null;
}

export function pduHostnameStem(name) {
  if (!name) return '';
  const m = String(name).trim().match(/^(.*)-(\d+)$/);
  return m ? m[1] : String(name).trim();
}

function chainTag(name) {
  const m = String(name || '').match(/CN(\d+)/i);
  return m ? `CN${String(m[1]).padStart(2, '0')}` : '';
}

/** Voltage/current that means the PDU (or daisy slave) is electrically live. */
export function pduIsElectricallyLive(current, voltage) {
  return (current != null && current > 0.05) || (voltage != null && voltage > 50);
}

export function aggregateCageMetrics(hallPDUs, pduLiveStatus, pduAlarms, pduEnv, fleetPduResults) {
  const online = hallPDUs.filter((p) => pduLiveStatus[p.ip] === 'online');
  let totalPowerW = 0;
  let totalCurrentA = 0;
  let voltageSum = 0;
  let voltageN = 0;
  let pfSum = 0;
  let pfN = 0;
  let totalEnergy = 0;
  let tempSum = 0;
  let tempN = 0;
  let humSum = 0;
  let humN = 0;
  let criticalCount = 0;
  let warningCount = 0;
  let phaseImbalanceCount = 0;
  const pduLoads = [];

  for (const pdu of hallPDUs) {
    const alarm = pduAlarms[pdu.ip];
    const entries = alarm?.entries || [];
    const loadFlags = (alarm?.flags || []).filter((f) => /outlet\d+_load/.test(f.param || ''));
    const loadEntries = entries.filter((e) => {
      const v = String(e.value || '').toLowerCase();
      return /^alarm_outlet\d+_load$/.test(e.key || '')
        || v.includes('cable disconnected') || v.includes('unplugged') || v.includes('load lost');
    });
    for (const e of entries) {
      if (loadEntries.includes(e)) continue;
      const v = String(e.value || '').toLowerCase();
      if (v.includes('critical') || v === 'open') criticalCount += 1;
      else if (v && v !== 'normal' && v !== '-') warningCount += 1;
    }
    warningCount += loadEntries.length + loadFlags.length;
    if (alarm?.count > 0 && entries.length === 0 && loadFlags.length === 0) warningCount += alarm.count;
    if (entries.some((e) => e.key === 'alarm_phase_unbalance' && String(e.value).toLowerCase() !== 'normal')) {
      phaseImbalanceCount += 1;
    }
  }

  for (const pdu of hallPDUs) {
    const isOnline = pduLiveStatus[pdu.ip] === 'online';
    const results = isOnline ? fleetPduResults[pdu.ip] : null;
    const power = pickNum(results, 'MasterPowerP1', 'total_active_power', 'l1_active_power') ?? 0;
    const current = pickNum(results, 'MasterCurrentP1', 'l1_current', 'total_current') ?? 0;
    const voltage = pickNum(results, 'MasterVoltageP1', 'l1_voltage');
    const pf = pickNum(results, 'MasterPFP1', 'total_pf', 'l1_pf');
    const energy = pickNum(results, 'MasterEnergyP1', 'total_active_energy') ?? 0;
    const live = pduIsElectricallyLive(current, voltage);

    if (isOnline) {
      totalPowerW += power;
      totalCurrentA += current;
      totalEnergy += energy;
      if (voltage != null) { voltageSum += voltage; voltageN += 1; }
      if (pf != null && pf > 0) { pfSum += pf; pfN += 1; }

      const env = pduEnv[pdu.ip] || {};
      const temp = parseFloat(env.temp ?? pickNum(results, 'Temperature1'));
      const hum = parseFloat(env.hum ?? pickNum(results, 'Humidity1'));
      if (!Number.isNaN(temp)) { tempSum += temp; tempN += 1; }
      if (!Number.isNaN(hum)) { humSum += hum; humN += 1; }
    }

    const hostname = pdu.hostname || pdu.label || '';
    pduLoads.push({
      label: pdu.label || pdu.ip,
      hostname,
      position: pdu.mount_position || '',
      ip: pdu.ip,
      current,
      power: power / 1000,
      voltage,
      pf,
      energy,
      online: isOnline,
      live,
      alarmCount: pduAlarms[pdu.ip]?.count || 0,
      stem: pduHostnameStem(hostname) || pdu.ip,
      chain: chainTag(hostname) || chainTag(pdu.label) || '—',
    });
  }

  const totalLoadKw = totalPowerW / 1000;
  const avgVoltage = voltageN ? voltageSum / voltageN : null;
  const avgPf = pfN ? pfSum / pfN : null;
  const apparentKva = avgPf && avgPf > 0 ? totalLoadKw / avgPf : totalLoadKw;
  const avgTemp = tempN ? tempSum / tempN : null;
  const avgHum = humN ? humSum / humN : null;

  const ratedAmpsPerPdu = 32;
  const totalRatedA = hallPDUs.length * ratedAmpsPerPdu;
  const utilizationPct = totalRatedA > 0 ? Math.min(100, (totalCurrentA / totalRatedA) * 100) : 0;
  const ratedKw = (totalRatedA * (avgVoltage || 230)) / 1000;
  const ratedKva = avgPf && avgPf > 0 ? ratedKw / avgPf : ratedKw * 1.05;
  const headroomKw = Math.max(0, ratedKw - totalLoadKw);
  const strandedKw = phaseImbalanceCount * (ratedKw / Math.max(1, hallPDUs.length)) * 0.15;
  const headroomPct = ratedKw > 0 ? (headroomKw / ratedKw) * 100 : 0;

  pduLoads.sort((a, b) => b.current - a.current);

  const chainMap = new Map();
  for (const p of pduLoads) {
    const key = p.stem || p.chain;
    if (!chainMap.has(key)) {
      chainMap.set(key, {
        id: p.chain !== '—' ? p.chain : key,
        stem: key,
        master: '',
        units: 0,
        live: 0,
        amps: 0,
        kw: 0,
      });
    }
    const c = chainMap.get(key);
    c.units += 1;
    if (p.live) c.live += 1;
    c.amps += p.current || 0;
    c.kw += p.power || 0;
    if (/-1$/.test(p.hostname || p.label || '') || !c.master) c.master = p.ip;
  }
  const chains = [...chainMap.values()].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

  const liveCount = pduLoads.filter((p) => p.live).length;
  const availabilityPct = hallPDUs.length ? (liveCount / hallPDUs.length) * 100 : 0;

  return {
    hasData: online.length > 0 && totalCurrentA > 0,
    onlineCount: online.length,
    liveCount,
    totalCount: hallPDUs.length,
    availabilityPct,
    totalLoadKw,
    totalCurrentA,
    avgVoltage,
    avgPf,
    apparentKva,
    totalEnergyKwh: totalEnergy,
    avgTemp,
    avgHum,
    criticalCount,
    warningCount,
    utilizationPct,
    ratedKw,
    ratedKva,
    totalRatedA,
    headroomKw,
    headroomPct,
    strandedKw,
    deployableKw: headroomKw * 0.85,
    phaseImbalanceCount,
    topPdus: pduLoads.slice(0, 4),
    allPdus: pduLoads,
    chains,
    pfLeading: avgPf != null && avgPf >= 0.98,
  };
}

/** Group hall PDUs into daisy-chain trees from hostname `-N` suffixes.
 *  `-1` is the master; `-2` / `-3` / `-4` are slaves on that master's bus.
 */

export function parseChainSuffix(name) {
  const m = String(name || '').trim().match(/^(.*)-(\d+)$/);
  if (!m) return null;
  const idx = Number(m[2]);
  if (!Number.isFinite(idx) || idx < 1) return null;
  return { stem: m[1], idx };
}

export function displayPduLabel(pdu) {
  return pdu?.label || pdu?.hostname || pdu?.ip || 'PDU';
}

export function groupPdusByChain(pdus) {
  const buckets = new Map();
  const standalone = [];

  for (const pdu of pdus || []) {
    const parsed = parseChainSuffix(pdu.hostname || pdu.label);
    if (!parsed) {
      standalone.push(pdu);
      continue;
    }
    if (!buckets.has(parsed.stem)) buckets.set(parsed.stem, []);
    buckets.get(parsed.stem).push({ pdu, idx: parsed.idx });
  }

  const chains = [];
  for (const [stem, members] of buckets) {
    members.sort((a, b) => a.idx - b.idx);
    const masterEntry = members.find((m) => m.idx === 1);
    const slaveEntries = members.filter((m) => m.idx > 1);
    chains.push({
      stem,
      master: masterEntry?.pdu || null,
      slaves: slaveEntries.map((s) => ({ pdu: s.pdu, idx: s.idx })),
      unitCount: members.length,
    });
  }

  chains.sort((a, b) => a.stem.localeCompare(b.stem, undefined, { numeric: true }));
  standalone.sort((a, b) => String(a.label || a.ip).localeCompare(String(b.label || b.ip), undefined, { numeric: true }));
  return { chains, standalone };
}

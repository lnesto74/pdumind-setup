import React, { useState } from 'react';

// Default sample specs if no props passed
const defaultSpecs = {
  model: 'DPDU-V3-C1308-10A',
  shell_material: {
    type: 'SGCC',
    thickness_mm: 1.2,
    finish: 'black powder',
  },
  input: {
    voltage_range_v: [220, 250],
    frequency_hz: [50, 60],
    plug_type: null,
    wire_specification: null,
  },
  output: {
    voltage_range_v: [220, 250],
    max_current_a: 10,
    sockets: {
      type: 'IEC C13',
      quantity: 8,
    },
  },
  internal_wiring: {
    main_line_mm2: 1.5,
  },
  installation: {
    mode: 'horizontal',
    input_position: 'rear',
  },
  control_unit: {
    type: 'DPDU V3 meter',
    display_features: [
      'kWh',
      'TX',
      'RUN',
      'UP',
      'DOWN',
      'SER',
      'NET',
      'IN',
      'OUT',
      'USB',
    ],
  },
  dimensions_mm: {
    length: 486,
    height: 44.4,
    depth: 150,
  },
  tolerances_mm: {
    general: 0.2,
  },
  mounting: {
    standard_hole_pattern: true,
  },
  metadata: {
    drawing_scale: '1:1',
    units: 'mm',
  },
};

// Utility to flatten specs into name-value pairs for table view
function specsToTableRows(specs) {
  const rows = [
    ['Model Number', specs.model || '--'],
    [
      'Shell Material',
      `${specs.shell_material?.thickness_mm ?? '--'}mm ${specs.shell_material?.type ?? ''}, ${specs.shell_material?.finish ?? ''}`,
    ],
    [
      'Input Voltage',
      `${specs.input?.voltage_range_v?.[0]}V – ${specs.input?.voltage_range_v?.[1]}V, ${specs.input?.frequency_hz?.[0]}/${specs.input?.frequency_hz?.[1]} Hz`,
    ],
    [
      'Output Voltage',
      `${specs.output?.voltage_range_v?.[0]}V – ${specs.output?.voltage_range_v?.[1]}V AC`,
    ],
    ['Max Current', `${specs.output?.max_current_a ?? '--'}A`],
    ['Input Plug', specs.input?.plug_type ?? 'Not specified'],
    [
      'Output Sockets',
      `${specs.output?.sockets?.quantity ?? '--'} × ${specs.output?.sockets?.type ?? ''}`,
    ],
    [
      'Internal Wiring',
      `${specs.internal_wiring?.main_line_mm2 ?? '--'}mm² main line`,
    ],
    [
      'Installation Mode',
      `${specs.installation?.mode ?? '--'} (${specs.installation?.input_position ?? ''}-input)`,
    ],
    ['Intelligent Control', specs.control_unit?.type ?? '--'],
    [
      'Dimensions',
      `${specs.dimensions_mm?.length} × ${specs.dimensions_mm?.height} × ${specs.dimensions_mm?.depth} mm`,
    ],
    [
      'Display / Meter',
      specs.control_unit?.display_features?.slice(0, 3).join(', ') + '...',
    ],
    [
      'Ports',
      specs.control_unit?.display_features?.filter((f) => ['USB', 'TX', 'NET', 'IN', 'OUT'].includes(f)).join(', '),
    ],
    [
      'Mounting Holes',
      specs.mounting?.standard_hole_pattern ? 'Standardized based on drawing positions' : '--',
    ],
  ];
  return rows;
}

export default function DesignSpecsCard({ specs = defaultSpecs }) {
  const [showJson, setShowJson] = useState(false);

  const tableRows = specsToTableRows(specs);

  return (
    <section className="glass-card design-specs-section">
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-title m-0">PDU DESIGN SPECS</h2>
        <button
          className="px-3 py-1 bg-cyan-600/80 hover:bg-cyan-700 text-sm rounded"
          onClick={() => setShowJson((prev) => !prev)}
        >
          {showJson ? 'Show Table' : 'Show JSON'}
        </button>
      </div>

      {showJson ? (
        <pre className="text-xs leading-snug whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
          {JSON.stringify(specs, null, 2)}
        </pre>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-cyan-400 border-b border-cyan-500/20 text-left">
              <th className="py-1 pr-2">Parameter</th>
              <th className="py-1 pl-2">Value / Description</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map(([param, value]) => (
              <tr key={param} className="border-b border-white/10 last:border-none">
                <td className="py-1 pr-2 font-mono text-gray-300 whitespace-nowrap">{param}</td>
                <td className="py-1 pl-2 text-gray-200">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

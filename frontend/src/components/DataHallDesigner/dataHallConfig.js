/**
 * Data Hall Configuration Model
 * Single source of truth for parametric 3D data hall generation
 */

// Default configuration
export const defaultDataHallConfig = {
  // Data Hall dimensions
  hall: {
    length: 20,        // meters
    width: 12,         // meters
    height: 3.5,       // meters
    floorTileSize: 0.6 // meters (standard raised floor tile)
  },
  
  // Layout parameters
  layout: {
    numberOfRows: 4,
    racksPerRow: 10,
    rowOrientation: 'lengthwise', // 'lengthwise' | 'widthwise'
    aisleWidth: 1.2,              // meters (hot/cold aisle)
    wallClearance: 1.5            // meters from walls
  },
  
  // Rack specifications
  rack: {
    width: 600,        // mm
    depth: 1000,       // mm
    heightU: 42,       // rack units
    model: 'Standard 42U'
  },
  
  // PDU configuration
  pdu: {
    pdusPerRack: 2,
    modelId: 'DPDU-V3-C1308-10A',
    mounting: 'A/B'    // 'A/B' | 'Left/Right'
  },
  
  // IP Planning
  ipPlanning: {
    subnet: '10.20.0.0/24',
    assignmentStrategy: 'sequential' // 'sequential' | 'perRowBlock'
  }
};

/**
 * Generate IP address from subnet and index
 */
function generateIP(subnet, index) {
  const [base, mask] = subnet.split('/');
  const parts = base.split('.').map(Number);
  const hostIndex = index + 1; // Start from .1
  
  // Simple sequential assignment within /24
  if (parseInt(mask) === 24) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.${hostIndex}`;
  }
  
  // For larger subnets, handle accordingly
  const totalIndex = hostIndex;
  return `${parts[0]}.${parts[1]}.${Math.floor(totalIndex / 256)}.${totalIndex % 256}`;
}

/**
 * Validate configuration against hall dimensions
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];
  
  const { hall, layout, rack } = config;
  
  // Convert rack dimensions to meters
  const rackWidthM = rack.width / 1000;
  const rackDepthM = rack.depth / 1000;
  
  // Calculate required space
  const rowWidth = layout.racksPerRow * rackWidthM;
  const totalRowsDepth = layout.numberOfRows * rackDepthM + 
                         (layout.numberOfRows - 1) * layout.aisleWidth;
  
  // Check length (along rows)
  const requiredLength = rowWidth + (2 * layout.wallClearance);
  if (requiredLength > hall.length) {
    errors.push({
      field: 'layout.racksPerRow',
      message: `Too many racks per row. Required length: ${requiredLength.toFixed(1)}m, Available: ${hall.length}m`
    });
  }
  
  // Check width (across rows)
  const requiredWidth = totalRowsDepth + (2 * layout.wallClearance);
  if (requiredWidth > hall.width) {
    errors.push({
      field: 'layout.numberOfRows',
      message: `Too many rows. Required width: ${requiredWidth.toFixed(1)}m, Available: ${hall.width}m`
    });
  }
  
  // Check height
  const rackHeightM = (rack.heightU * 44.45) / 1000; // 1U = 44.45mm
  if (rackHeightM > hall.height - 0.3) { // 30cm clearance
    warnings.push({
      field: 'rack.heightU',
      message: `Rack height (${rackHeightM.toFixed(2)}m) is close to ceiling height (${hall.height}m)`
    });
  }
  
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Generate complete data hall layout from configuration
 * This is a pure function - same config always produces same layout
 */
export function generateDataHallLayout(config) {
  const validation = validateConfig(config);
  if (!validation.valid) {
    return { success: false, errors: validation.errors, warnings: validation.warnings };
  }
  
  const { hall, layout, rack, pdu, ipPlanning } = config;
  
  // Convert dimensions to meters
  const rackWidthM = rack.width / 1000;
  const rackDepthM = rack.depth / 1000;
  const rackHeightM = (rack.heightU * 44.45) / 1000;
  
  const rows = [];
  const racks = [];
  const pdus = [];
  
  let ipIndex = 0;
  let rackGlobalIndex = 0;
  
  // Calculate starting positions
  const totalRowWidth = layout.racksPerRow * rackWidthM;
  const startX = (hall.length - totalRowWidth) / 2;
  
  const totalRowsDepth = layout.numberOfRows * rackDepthM + 
                         (layout.numberOfRows - 1) * layout.aisleWidth;
  const startZ = (hall.width - totalRowsDepth) / 2;
  
  // Generate rows
  for (let rowIdx = 0; rowIdx < layout.numberOfRows; rowIdx++) {
    const rowId = `Row-${String(rowIdx + 1).padStart(2, '0')}`;
    const rowZ = startZ + rowIdx * (rackDepthM + layout.aisleWidth);
    
    const rowRacks = [];
    
    // Generate racks in this row
    for (let rackIdx = 0; rackIdx < layout.racksPerRow; rackIdx++) {
      const rackId = `${rowId}/Rack-${String(rackIdx + 1).padStart(2, '0')}`;
      const rackX = startX + rackIdx * rackWidthM;
      
      const rackInstance = {
        id: rackId,
        globalIndex: rackGlobalIndex,
        rowIndex: rowIdx,
        positionInRow: rackIdx,
        position: {
          x: rackX + rackWidthM / 2, // Center of rack
          y: 0,
          z: rowZ + rackDepthM / 2
        },
        dimensions: {
          width: rackWidthM,
          depth: rackDepthM,
          height: rackHeightM
        },
        model: rack.model,
        heightU: rack.heightU,
        pdus: []
      };
      
      // Generate PDUs for this rack
      for (let pduIdx = 0; pduIdx < pdu.pdusPerRack; pduIdx++) {
        const position = pdu.mounting === 'A/B' 
          ? (pduIdx === 0 ? 'A' : 'B')
          : (pduIdx === 0 ? 'Left' : 'Right');
        
        const pduId = `${rackId}/PDU-${position}`;
        const assignedIP = generateIP(ipPlanning.subnet, ipIndex);
        
        const pduInstance = {
          id: pduId,
          rackId: rackId,
          position: position,
          model: pdu.modelId,
          ip: assignedIP,
          globalIndex: ipIndex
        };
        
        pdus.push(pduInstance);
        rackInstance.pdus.push(pduInstance);
        ipIndex++;
      }
      
      racks.push(rackInstance);
      rowRacks.push(rackInstance);
      rackGlobalIndex++;
    }
    
    rows.push({
      id: rowId,
      index: rowIdx,
      position: { x: startX + totalRowWidth / 2, z: rowZ + rackDepthM / 2 },
      racks: rowRacks
    });
  }
  
  // Calculate floor grid
  const tilesX = Math.ceil(hall.length / hall.floorTileSize);
  const tilesZ = Math.ceil(hall.width / hall.floorTileSize);
  
  return {
    success: true,
    errors: [],
    warnings: validation.warnings,
    layout: {
      hall: {
        length: hall.length,
        width: hall.width,
        height: hall.height
      },
      floor: {
        tileSize: hall.floorTileSize,
        tilesX,
        tilesZ
      },
      rows,
      racks,
      pdus,
      stats: {
        totalRacks: racks.length,
        totalPDUs: pdus.length,
        totalRows: rows.length,
        usedFloorArea: (totalRowWidth * totalRowsDepth).toFixed(1),
        totalFloorArea: (hall.length * hall.width).toFixed(1)
      }
    }
  };
}

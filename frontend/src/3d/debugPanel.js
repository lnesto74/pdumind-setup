/**
 * debugPanel.js - Memory & Performance Monitoring for Three.js
 * 
 * Provides a visual overlay showing:
 * - FPS counter
 * - Memory usage (geometries, textures, programs)
 * - Instance counts
 * - ModelCache statistics
 * 
 * Usage:
 *   import { DebugPanel } from './debugPanel';
 *   const panel = new DebugPanel(renderer);
 *   panel.show();
 *   
 *   // In animation loop:
 *   panel.update();
 */

import { modelCache } from './ModelCache';
import { refCounter, getMemoryStats } from './dispose';

/**
 * DebugPanel - Visual performance/memory monitoring overlay
 */
export class DebugPanel {
  /**
   * @param {THREE.WebGLRenderer} renderer - The WebGL renderer to monitor
   * @param {Object} options - Configuration options
   */
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.options = {
      position: options.position || 'top-left', // top-left, top-right, bottom-left, bottom-right
      updateInterval: options.updateInterval || 500, // ms between updates
      showFPS: options.showFPS ?? true,
      showMemory: options.showMemory ?? true,
      showCache: options.showCache ?? true,
      ...options
    };

    this.container = null;
    this.isVisible = false;
    this.lastTime = performance.now();
    this.frames = 0;
    this.fps = 0;
    this.updateTimer = null;

    // Stats history for graphs
    this.history = {
      fps: [],
      geometries: [],
      textures: []
    };
    this.maxHistoryLength = 60;

    // Custom stats trackers
    this.customStats = new Map();

    this._createPanel();
  }

  /**
   * Create the debug panel DOM element
   */
  _createPanel() {
    // Create container
    this.container = document.createElement('div');
    this.container.id = 'three-debug-panel';
    this.container.style.cssText = `
      position: fixed;
      ${this._getPositionStyles()}
      z-index: 10000;
      background: rgba(0, 0, 0, 0.85);
      color: #00ff88;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 11px;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid #00ff88;
      min-width: 200px;
      pointer-events: none;
      user-select: none;
      display: none;
      backdrop-filter: blur(4px);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      font-weight: bold;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid #00ff8844;
      color: #00e5ff;
    `;
    header.textContent = '🔧 THREE.js Debug';
    this.container.appendChild(header);

    // Stats container
    this.statsContainer = document.createElement('div');
    this.statsContainer.style.cssText = `
      display: grid;
      gap: 4px;
    `;
    this.container.appendChild(this.statsContainer);

    document.body.appendChild(this.container);
  }

  /**
   * Get CSS position styles based on options
   */
  _getPositionStyles() {
    switch (this.options.position) {
      case 'top-right':
        return 'top: 10px; right: 10px;';
      case 'bottom-left':
        return 'bottom: 10px; left: 10px;';
      case 'bottom-right':
        return 'bottom: 10px; right: 10px;';
      case 'top-left':
      default:
        return 'top: 10px; left: 10px;';
    }
  }

  /**
   * Show the debug panel
   */
  show() {
    if (this.isVisible) return;
    this.isVisible = true;
    this.container.style.display = 'block';
    this._startUpdating();
  }

  /**
   * Hide the debug panel
   */
  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.container.style.display = 'none';
    this._stopUpdating();
  }

  /**
   * Toggle visibility
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Start periodic updates
   */
  _startUpdating() {
    if (this.updateTimer) return;
    this.updateTimer = setInterval(() => {
      this._updateStats();
    }, this.options.updateInterval);
  }

  /**
   * Stop periodic updates
   */
  _stopUpdating() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * Call this every frame to track FPS
   */
  update() {
    this.frames++;
    const now = performance.now();
    const delta = now - this.lastTime;

    if (delta >= 1000) {
      this.fps = Math.round((this.frames * 1000) / delta);
      this.frames = 0;
      this.lastTime = now;

      // Add to history
      this.history.fps.push(this.fps);
      if (this.history.fps.length > this.maxHistoryLength) {
        this.history.fps.shift();
      }
    }
  }

  /**
   * Update stats display
   */
  _updateStats() {
    if (!this.isVisible) return;

    const stats = [];

    // FPS
    if (this.options.showFPS) {
      const fpsColor = this.fps >= 55 ? '#00ff88' : this.fps >= 30 ? '#ffaa00' : '#ff4444';
      stats.push({
        label: 'FPS',
        value: this.fps,
        color: fpsColor
      });
    }

    // Memory stats from renderer
    if (this.options.showMemory && this.renderer) {
      const memStats = getMemoryStats(this.renderer);
      if (memStats) {
        stats.push({
          label: 'Geometries',
          value: memStats.geometries,
          color: '#88ccff'
        });
        stats.push({
          label: 'Textures',
          value: memStats.textures,
          color: '#88ccff'
        });
        stats.push({
          label: 'Programs',
          value: memStats.programs,
          color: '#88ccff'
        });
        stats.push({
          label: 'Draw Calls',
          value: memStats.render.calls,
          color: '#cccccc'
        });
        stats.push({
          label: 'Triangles',
          value: this._formatNumber(memStats.render.triangles),
          color: '#cccccc'
        });

        // Track history
        this.history.geometries.push(memStats.geometries);
        this.history.textures.push(memStats.textures);
        if (this.history.geometries.length > this.maxHistoryLength) {
          this.history.geometries.shift();
          this.history.textures.shift();
        }
      }
    }

    // ModelCache stats
    if (this.options.showCache) {
      const cacheStats = modelCache.getStats();
      stats.push({
        label: 'Cached Models',
        value: cacheStats.cachedModels,
        color: '#ff88ff'
      });

      // Ref counter stats
      const refStats = refCounter.getStats();
      stats.push({
        label: 'Tracked Refs',
        value: refStats.total,
        color: '#ff88ff'
      });
    }

    // Custom stats
    for (const [label, getter] of this.customStats) {
      try {
        const value = typeof getter === 'function' ? getter() : getter;
        stats.push({
          label,
          value,
          color: '#ffcc88'
        });
      } catch (e) {
        // Skip failed custom stats
      }
    }

    // Render stats
    this._renderStats(stats);
  }

  /**
   * Render stats to DOM
   */
  _renderStats(stats) {
    this.statsContainer.innerHTML = stats.map(stat => `
      <div style="display: flex; justify-content: space-between; gap: 20px;">
        <span style="color: #888;">${stat.label}:</span>
        <span style="color: ${stat.color}; font-weight: bold;">${stat.value}</span>
      </div>
    `).join('');
  }

  /**
   * Format large numbers with K/M suffix
   */
  _formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  /**
   * Add a custom stat tracker
   * @param {string} label - Display label
   * @param {Function|any} getter - Function that returns the value, or static value
   */
  addCustomStat(label, getter) {
    this.customStats.set(label, getter);
  }

  /**
   * Remove a custom stat tracker
   * @param {string} label 
   */
  removeCustomStat(label) {
    this.customStats.delete(label);
  }

  /**
   * Get current stats as object (for logging)
   */
  getStats() {
    const memStats = this.renderer ? getMemoryStats(this.renderer) : null;
    const cacheStats = modelCache.getStats();
    const refStats = refCounter.getStats();

    return {
      fps: this.fps,
      memory: memStats,
      cache: cacheStats,
      refCounter: refStats,
      history: this.history
    };
  }

  /**
   * Log current stats to console
   */
  logStats() {
    console.table(this.getStats());
  }

  /**
   * Dispose the debug panel
   */
  dispose() {
    this._stopUpdating();
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
    this.customStats.clear();
  }
}

/**
 * Quick helper to create and show a debug panel
 * @param {THREE.WebGLRenderer} renderer 
 * @param {Object} options 
 * @returns {DebugPanel}
 */
export function createDebugPanel(renderer, options = {}) {
  const panel = new DebugPanel(renderer, options);
  panel.show();
  return panel;
}

/**
 * Console-only stats reporter (no DOM, for headless/testing)
 */
export function logMemoryStats(renderer, label = 'Memory Stats') {
  const stats = getMemoryStats(renderer);
  const cacheStats = modelCache.getStats();

  console.group(label);
  console.log('Geometries:', stats?.geometries);
  console.log('Textures:', stats?.textures);
  console.log('Draw Calls:', stats?.render?.calls);
  console.log('Triangles:', stats?.render?.triangles);
  console.log('Cached Models:', cacheStats.cachedModels);
  console.log('Ref Counter:', refCounter.getStats());
  console.groupEnd();
}

export default DebugPanel;

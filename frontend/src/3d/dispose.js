/**
 * dispose.js - Memory Management & Cleanup Utilities
 * 
 * Provides robust disposal of Three.js objects with reference counting
 * to prevent disposing shared resources prematurely.
 * 
 * Features:
 * - Reference counting for shared geometries, materials, textures
 * - Safe disposal that checks ref counts before disposing
 * - Deep disposal of Object3D hierarchies
 * - Firefox-safe cleanup (no memory leaks)
 */

import * as THREE from 'three';

/**
 * Reference counter for shared Three.js resources
 */
class ResourceRefCounter {
  constructor() {
    // uuid -> { resource, refCount, type }
    this.resources = new Map();
  }

  /**
   * Register a resource and increment its reference count
   * @param {Object} resource - THREE.Geometry, THREE.Material, or THREE.Texture
   * @param {string} type - 'geometry' | 'material' | 'texture'
   */
  acquire(resource, type = 'unknown') {
    if (!resource || !resource.uuid) return;

    if (this.resources.has(resource.uuid)) {
      const entry = this.resources.get(resource.uuid);
      entry.refCount++;
      return entry.refCount;
    }

    this.resources.set(resource.uuid, {
      resource,
      refCount: 1,
      type
    });

    return 1;
  }

  /**
   * Decrement reference count and dispose if zero
   * @param {Object} resource 
   * @returns {boolean} True if resource was disposed
   */
  release(resource) {
    if (!resource || !resource.uuid) return false;

    const entry = this.resources.get(resource.uuid);
    if (!entry) return false;

    entry.refCount--;

    if (entry.refCount <= 0) {
      this._disposeResource(entry);
      this.resources.delete(resource.uuid);
      return true;
    }

    return false;
  }

  /**
   * Get current reference count for a resource
   */
  getRefCount(resource) {
    if (!resource || !resource.uuid) return 0;
    const entry = this.resources.get(resource.uuid);
    return entry ? entry.refCount : 0;
  }

  /**
   * Internal: Dispose a resource based on its type
   */
  _disposeResource(entry) {
    const { resource, type } = entry;

    try {
      if (type === 'geometry' || resource.isBufferGeometry) {
        resource.dispose();
      } else if (type === 'material' || resource.isMaterial) {
        // Dispose material textures first
        this._disposeMaterialTextures(resource);
        resource.dispose();
      } else if (type === 'texture' || resource.isTexture) {
        resource.dispose();
      } else if (resource.dispose) {
        resource.dispose();
      }
    } catch (e) {
      console.warn('[dispose] Error disposing resource:', e);
    }
  }

  /**
   * Dispose all textures attached to a material
   */
  _disposeMaterialTextures(material) {
    const textureProps = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
      'envMap', 'lightMap', 'specularMap', 'gradientMap'
    ];

    textureProps.forEach(prop => {
      const texture = material[prop];
      if (texture && texture.isTexture) {
        // Only dispose if not tracked or refCount is 0
        if (!this.resources.has(texture.uuid) || this.release(texture)) {
          // Already disposed by release()
        }
      }
    });
  }

  /**
   * Get statistics about tracked resources
   */
  getStats() {
    const stats = {
      total: this.resources.size,
      byType: {
        geometry: 0,
        material: 0,
        texture: 0,
        unknown: 0
      }
    };

    for (const entry of this.resources.values()) {
      if (stats.byType[entry.type] !== undefined) {
        stats.byType[entry.type]++;
      } else {
        stats.byType.unknown++;
      }
    }

    return stats;
  }

  /**
   * Force dispose all tracked resources (cleanup)
   */
  disposeAll() {
    for (const entry of this.resources.values()) {
      this._disposeResource(entry);
    }
    this.resources.clear();
  }
}

// Singleton instance
export const refCounter = new ResourceRefCounter();

/**
 * Dispose an Object3D and all its descendants
 * Respects reference counting for shared resources
 * 
 * @param {THREE.Object3D} object - Root object to dispose
 * @param {Object} options - Disposal options
 * @param {boolean} options.disposeGeometry - Dispose geometries (default: true)
 * @param {boolean} options.disposeMaterial - Dispose materials (default: true) 
 * @param {boolean} options.disposeTextures - Dispose textures (default: true)
 * @param {boolean} options.removeFromParent - Remove from parent (default: true)
 * @param {boolean} options.useRefCounting - Use reference counting (default: true)
 */
export function disposeObject3D(object, options = {}) {
  const {
    disposeGeometry = true,
    disposeMaterial = true,
    disposeTextures = true,
    removeFromParent = true,
    useRefCounting = true
  } = options;

  if (!object) return;

  // Remove from parent first
  if (removeFromParent && object.parent) {
    object.parent.remove(object);
  }

  // Traverse and dispose
  object.traverse((node) => {
    // Dispose geometry
    if (disposeGeometry && node.geometry) {
      if (useRefCounting) {
        refCounter.release(node.geometry);
      } else {
        node.geometry.dispose();
      }
      node.geometry = null;
    }

    // Dispose materials
    if (disposeMaterial && node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      
      materials.forEach(material => {
        if (!material) return;

        // Dispose textures from material
        if (disposeTextures) {
          const textureProps = [
            'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
            'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
            'envMap', 'lightMap', 'specularMap'
          ];

          textureProps.forEach(prop => {
            const texture = material[prop];
            if (texture) {
              if (useRefCounting) {
                refCounter.release(texture);
              } else {
                texture.dispose();
              }
              material[prop] = null;
            }
          });
        }

        // Dispose material
        if (useRefCounting) {
          refCounter.release(material);
        } else {
          material.dispose();
        }
      });

      node.material = null;
    }

    // Clear any render targets
    if (node.renderTarget) {
      node.renderTarget.dispose();
      node.renderTarget = null;
    }

    // Clear userData to help GC
    node.userData = {};
  });

  // Clear children array
  while (object.children.length > 0) {
    object.remove(object.children[0]);
  }
}

/**
 * Dispose a scene completely, including renderer resources
 * @param {THREE.Scene} scene 
 * @param {THREE.WebGLRenderer} renderer 
 */
export function disposeScene(scene, renderer = null) {
  if (!scene) return;

  // Dispose all scene children
  while (scene.children.length > 0) {
    disposeObject3D(scene.children[0]);
  }

  // Clear scene background/environment
  if (scene.background && scene.background.isTexture) {
    scene.background.dispose();
  }
  if (scene.environment && scene.environment.isTexture) {
    scene.environment.dispose();
  }

  scene.background = null;
  scene.environment = null;

  // Clear renderer caches if provided
  if (renderer) {
    renderer.renderLists.dispose();
    renderer.info.reset();
  }
}

/**
 * Register resources from an Object3D for reference counting
 * Call this when cloning/sharing resources
 * 
 * @param {THREE.Object3D} object 
 */
export function acquireResources(object) {
  if (!object) return;

  object.traverse((node) => {
    if (node.geometry) {
      refCounter.acquire(node.geometry, 'geometry');
    }

    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach(material => {
        if (material) {
          refCounter.acquire(material, 'material');

          // Also track textures
          const textureProps = [
            'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
            'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap'
          ];
          textureProps.forEach(prop => {
            if (material[prop]) {
              refCounter.acquire(material[prop], 'texture');
            }
          });
        }
      });
    }
  });
}

/**
 * Force garbage collection hint (not guaranteed)
 * Useful after large disposal operations
 */
export function forceGCHint() {
  // Clear any weak references
  if (typeof window !== 'undefined' && window.gc) {
    try {
      window.gc();
    } catch (e) {
      // gc() not available
    }
  }
}

/**
 * Get memory usage statistics from WebGL renderer
 * @param {THREE.WebGLRenderer} renderer 
 */
export function getMemoryStats(renderer) {
  if (!renderer || !renderer.info) {
    return null;
  }

  const info = renderer.info;
  return {
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length || 0,
    render: {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines
    },
    refCounter: refCounter.getStats()
  };
}

export default {
  disposeObject3D,
  disposeScene,
  acquireResources,
  refCounter,
  getMemoryStats,
  forceGCHint
};

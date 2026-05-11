/**
 * ModelCache - Load GLB/GLTF models once, reuse many times
 * 
 * This module ensures each model URL is loaded only once and returns a reusable
 * prototype. Concurrent calls to get(url) share the same in-flight Promise.
 * 
 * Usage:
 *   const prototype = await modelCache.get('/models/rack.glb');
 *   // Use prototype.scene for cloning or instancing
 *   
 * Memory Management:
 *   - Call acquire(url) when using a model
 *   - Call release(url) when done
 *   - Resources are disposed when refCount reaches 0
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader';

class ModelCacheManager {
  constructor() {
    // Cache storage: url -> { prototype, refCount, loadPromise }
    this.cache = new Map();
    
    // Shared loader instances (avoid recreating)
    this.gltfLoader = new GLTFLoader();
    
    // Optional: Setup DRACO decoder for compressed models
    try {
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
      this.gltfLoader.setDRACOLoader(dracoLoader);
    } catch (e) {
      console.warn('[ModelCache] DRACO loader not available:', e);
    }
    
    // Loading manager to track progress
    this.loadingManager = new THREE.LoadingManager();
  }

  /**
   * Get a cached model prototype. Loads only once per URL.
   * @param {string} url - Model URL (GLB/GLTF)
   * @param {Object} options - Loading options
   * @returns {Promise<{scene: THREE.Group, animations: THREE.AnimationClip[], meshes: Map, materials: Map, geometries: Map}>}
   */
  async get(url, options = {}) {
    // Return cached prototype if available
    if (this.cache.has(url)) {
      const entry = this.cache.get(url);
      
      // If still loading, wait for the same promise (dedupe parallel loads)
      if (entry.loadPromise) {
        return entry.loadPromise;
      }
      
      return entry.prototype;
    }

    // Create entry with loading promise to dedupe concurrent calls
    const entry = {
      prototype: null,
      refCount: 0,
      loadPromise: null
    };
    this.cache.set(url, entry);

    // Create and store the loading promise
    entry.loadPromise = this._loadModel(url, options);
    
    try {
      const prototype = await entry.loadPromise;
      entry.prototype = prototype;
      entry.loadPromise = null; // Clear promise after successful load
      return prototype;
    } catch (error) {
      // Remove failed entry from cache
      this.cache.delete(url);
      throw error;
    }
  }

  /**
   * Internal model loading with resource indexing
   */
  async _loadModel(url, options = {}) {
    return new Promise((resolve, reject) => {
      this.gltfLoader.load(
        url,
        (gltf) => {
          // Build resource indices for efficient reuse
          const meshes = new Map();
          const materials = new Map();
          const geometries = new Map();
          const textures = new Map();

          // Traverse and index all resources
          gltf.scene.traverse((node) => {
            if (node.isMesh) {
              meshes.set(node.uuid, node);
              
              // Index geometry
              if (node.geometry && !geometries.has(node.geometry.uuid)) {
                geometries.set(node.geometry.uuid, node.geometry);
              }
              
              // Index materials (handle arrays)
              const mats = Array.isArray(node.material) ? node.material : [node.material];
              mats.forEach(mat => {
                if (mat && !materials.has(mat.uuid)) {
                  materials.set(mat.uuid, mat);
                  
                  // Index textures from material
                  this._extractTextures(mat, textures);
                }
              });
            }
          });

          // Prepare prototype object
          const prototype = {
            scene: gltf.scene,
            animations: gltf.animations || [],
            meshes,
            materials,
            geometries,
            textures,
            url
          };

          // Clear references to raw GLTF data to allow GC
          gltf.parser = null;
          
          console.log(`[ModelCache] Loaded: ${url}`, {
            meshes: meshes.size,
            materials: materials.size,
            geometries: geometries.size,
            textures: textures.size
          });

          resolve(prototype);
        },
        // Progress callback
        (progress) => {
          if (options.onProgress) {
            options.onProgress(progress);
          }
        },
        // Error callback
        (error) => {
          console.error(`[ModelCache] Failed to load: ${url}`, error);
          reject(error);
        }
      );
    });
  }

  /**
   * Extract all textures from a material
   */
  _extractTextures(material, textureMap) {
    const textureProps = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
      'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap',
      'envMap', 'lightMap', 'specularMap'
    ];

    textureProps.forEach(prop => {
      const texture = material[prop];
      if (texture && texture.isTexture && !textureMap.has(texture.uuid)) {
        textureMap.set(texture.uuid, texture);
      }
    });
  }

  /**
   * Acquire a reference to a cached model
   * @param {string} url 
   */
  acquire(url) {
    const entry = this.cache.get(url);
    if (entry) {
      entry.refCount++;
      return entry.refCount;
    }
    return 0;
  }

  /**
   * Release a reference to a cached model
   * @param {string} url 
   * @param {boolean} forceDispose - Force dispose even if refCount > 0
   */
  release(url, forceDispose = false) {
    const entry = this.cache.get(url);
    if (!entry) return;

    entry.refCount = Math.max(0, entry.refCount - 1);

    if (entry.refCount === 0 || forceDispose) {
      this._disposePrototype(entry.prototype);
      this.cache.delete(url);
      console.log(`[ModelCache] Disposed: ${url}`);
    }

    return entry.refCount;
  }

  /**
   * Clear specific URL or entire cache
   * @param {string} url - Optional URL to clear, clears all if not provided
   */
  clear(url) {
    if (url) {
      this.release(url, true);
    } else {
      // Clear all
      for (const [cachedUrl, entry] of this.cache) {
        this._disposePrototype(entry.prototype);
      }
      this.cache.clear();
      console.log('[ModelCache] Cleared all cached models');
    }
  }

  /**
   * Dispose all resources in a prototype
   */
  _disposePrototype(prototype) {
    if (!prototype) return;

    // Dispose geometries
    prototype.geometries?.forEach(geometry => {
      geometry.dispose();
    });

    // Dispose materials and their textures
    prototype.materials?.forEach(material => {
      // Dispose textures first
      const textureProps = [
        'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap',
        'emissiveMap', 'bumpMap', 'displacementMap', 'alphaMap'
      ];
      textureProps.forEach(prop => {
        if (material[prop]) {
          material[prop].dispose();
        }
      });
      material.dispose();
    });

    // Clear the scene
    if (prototype.scene) {
      prototype.scene.traverse(node => {
        if (node.isMesh) {
          node.geometry = null;
          node.material = null;
        }
      });
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      cachedModels: this.cache.size,
      models: []
    };

    for (const [url, entry] of this.cache) {
      stats.models.push({
        url,
        refCount: entry.refCount,
        meshes: entry.prototype?.meshes?.size || 0,
        geometries: entry.prototype?.geometries?.size || 0,
        materials: entry.prototype?.materials?.size || 0,
        textures: entry.prototype?.textures?.size || 0
      });
    }

    return stats;
  }

  /**
   * Check if a model is cached
   */
  has(url) {
    return this.cache.has(url) && this.cache.get(url).prototype !== null;
  }
}

// Singleton instance
export const modelCache = new ModelCacheManager();
export default modelCache;

/**
 * InstanceFactory - GPU Instancing for Identical Meshes
 * 
 * Creates THREE.InstancedMesh objects from prototype models for efficient
 * rendering of thousands of identical objects with minimal memory overhead.
 * 
 * WHEN TO USE INSTANCING vs CLONE:
 * - USE INSTANCING: Same model repeated many times with only position/rotation/scale differences
 * - USE CLONE: Models need unique materials, morph targets, or skeletal animation per instance
 * 
 * Usage:
 *   const factory = new InstanceFactory(prototype, maxCount);
 *   factory.addToScene(scene);
 *   
 *   // Add instances
 *   const id1 = factory.addInstance({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
 *   const id2 = factory.addInstance({ position: [5, 0, 0] });
 *   
 *   // Update transforms
 *   factory.setTransform(id1, { position: [1, 0, 0] });
 *   factory.update(); // Apply changes to GPU
 */

import * as THREE from 'three';

// Reusable temp objects to avoid allocations in tight loops
const _tempMatrix = new THREE.Matrix4();
const _tempPosition = new THREE.Vector3();
const _tempQuaternion = new THREE.Quaternion();
const _tempScale = new THREE.Vector3(1, 1, 1);
const _tempEuler = new THREE.Euler();

/**
 * InstanceFactory - Manages instanced rendering of a prototype model
 */
export class InstanceFactory {
  /**
   * @param {Object} prototype - Prototype from ModelCache.get()
   * @param {number} maxCount - Maximum number of instances (pre-allocated)
   * @param {Object} options - Configuration options
   */
  constructor(prototype, maxCount = 1000, options = {}) {
    this.prototype = prototype;
    this.maxCount = maxCount;
    this.options = {
      castShadow: options.castShadow ?? true,
      receiveShadow: options.receiveShadow ?? true,
      frustumCulled: options.frustumCulled ?? true,
      ...options
    };

    // Instance tracking
    this.instanceCount = 0;
    this.freeIndices = []; // Recycled indices from removed instances
    this.instanceData = new Map(); // instanceId -> { index, position, rotation, scale }

    // InstancedMesh objects (one per geometry+material group)
    this.instancedMeshes = [];
    this.meshGroups = new Map(); // groupKey -> { instancedMesh, geometry, material }

    // Parent group for all instanced meshes
    this.group = new THREE.Group();
    this.group.name = 'InstanceFactory_' + (prototype.url || 'unknown');

    // Build instanced meshes from prototype
    this._buildInstancedMeshes();

    // Track if matrices need update
    this._needsUpdate = false;
  }

  /**
   * Build InstancedMesh objects from prototype scene
   */
  _buildInstancedMeshes() {
    if (!this.prototype?.scene) {
      console.warn('[InstanceFactory] No prototype scene provided');
      return;
    }

    // Extract all meshes and group by geometry+material
    this.prototype.scene.traverse((node) => {
      if (!node.isMesh) return;

      // Skip skinned meshes (can't be instanced)
      if (node.isSkinnedMesh) {
        console.warn('[InstanceFactory] Skinned mesh detected, skipping:', node.name);
        return;
      }

      const geometry = node.geometry;
      const materials = Array.isArray(node.material) ? node.material : [node.material];

      materials.forEach((material, materialIndex) => {
        if (!material) return;

        // Create unique key for this geometry+material combination
        const groupKey = `${geometry.uuid}-${material.uuid}`;

        if (!this.meshGroups.has(groupKey)) {
          // Create InstancedMesh for this group
          const instancedMesh = new THREE.InstancedMesh(
            geometry,
            material,
            this.maxCount
          );

          // Configure mesh
          instancedMesh.name = `Instanced_${node.name || 'mesh'}_${materialIndex}`;
          instancedMesh.castShadow = this.options.castShadow;
          instancedMesh.receiveShadow = this.options.receiveShadow;
          instancedMesh.frustumCulled = this.options.frustumCulled;
          instancedMesh.count = 0; // Start with 0 visible instances

          // Set instance matrix usage for dynamic updates
          instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

          // Store original transform from prototype
          const originalMatrix = new THREE.Matrix4();
          node.updateWorldMatrix(true, false);
          originalMatrix.copy(node.matrixWorld);

          this.meshGroups.set(groupKey, {
            instancedMesh,
            geometry,
            material,
            originalMatrix,
            nodeName: node.name
          });

          this.instancedMeshes.push(instancedMesh);
          this.group.add(instancedMesh);
        }
      });
    });

    console.log(`[InstanceFactory] Created ${this.instancedMeshes.length} instanced mesh groups for max ${this.maxCount} instances`);
  }

  /**
   * Add the instance factory's group to a scene
   * @param {THREE.Scene|THREE.Group} parent 
   */
  addToScene(parent) {
    parent.add(this.group);
  }

  /**
   * Remove from scene
   * @param {THREE.Scene|THREE.Group} parent 
   */
  removeFromScene(parent) {
    parent.remove(this.group);
  }

  /**
   * Add a new instance
   * @param {Object} transform - { position: [x,y,z], rotation: [x,y,z], scale: [x,y,z] | number }
   * @returns {number} Instance ID
   */
  addInstance(transform = {}) {
    // Get next available index
    let index;
    if (this.freeIndices.length > 0) {
      index = this.freeIndices.pop();
    } else {
      if (this.instanceCount >= this.maxCount) {
        console.warn(`[InstanceFactory] Max instance count (${this.maxCount}) reached`);
        return -1;
      }
      index = this.instanceCount;
    }

    // Parse transform
    const position = transform.position || [0, 0, 0];
    const rotation = transform.rotation || [0, 0, 0];
    let scale = transform.scale;
    if (typeof scale === 'number') {
      scale = [scale, scale, scale];
    } else if (!scale) {
      scale = [1, 1, 1];
    }

    // Store instance data
    const instanceId = index;
    this.instanceData.set(instanceId, {
      index,
      position: [...position],
      rotation: [...rotation],
      scale: [...scale],
      visible: true
    });

    // Set initial transform
    this._updateInstanceMatrix(index, position, rotation, scale);

    // Update instance count for all meshes
    this.instanceCount = Math.max(this.instanceCount, index + 1);
    this._updateMeshCounts();

    this._needsUpdate = true;
    return instanceId;
  }

  /**
   * Remove an instance
   * @param {number} instanceId 
   */
  removeInstance(instanceId) {
    const data = this.instanceData.get(instanceId);
    if (!data) return false;

    // Hide this instance by setting scale to 0
    this._updateInstanceMatrix(data.index, [0, 0, 0], [0, 0, 0], [0, 0, 0]);

    // Recycle the index
    this.freeIndices.push(data.index);
    this.instanceData.delete(instanceId);

    this._needsUpdate = true;
    return true;
  }

  /**
   * Set transform for an existing instance
   * @param {number} instanceId 
   * @param {Object} transform - Partial transform { position?, rotation?, scale? }
   */
  setTransform(instanceId, transform) {
    const data = this.instanceData.get(instanceId);
    if (!data) return false;

    // Merge with existing data
    if (transform.position) data.position = [...transform.position];
    if (transform.rotation) data.rotation = [...transform.rotation];
    if (transform.scale !== undefined) {
      if (typeof transform.scale === 'number') {
        data.scale = [transform.scale, transform.scale, transform.scale];
      } else {
        data.scale = [...transform.scale];
      }
    }

    // Update matrix
    this._updateInstanceMatrix(data.index, data.position, data.rotation, data.scale);
    this._needsUpdate = true;
    return true;
  }

  /**
   * Get transform for an instance
   * @param {number} instanceId 
   */
  getTransform(instanceId) {
    const data = this.instanceData.get(instanceId);
    if (!data) return null;
    return {
      position: [...data.position],
      rotation: [...data.rotation],
      scale: [...data.scale]
    };
  }

  /**
   * Update instance matrix (internal, uses reusable temp objects)
   */
  _updateInstanceMatrix(index, position, rotation, scale) {
    // Use pre-allocated temp objects (no allocations!)
    _tempPosition.set(position[0], position[1], position[2]);
    _tempEuler.set(rotation[0], rotation[1], rotation[2]);
    _tempQuaternion.setFromEuler(_tempEuler);
    _tempScale.set(scale[0], scale[1], scale[2]);

    _tempMatrix.compose(_tempPosition, _tempQuaternion, _tempScale);

    // Apply to all instanced meshes
    for (const { instancedMesh, originalMatrix } of this.meshGroups.values()) {
      // Combine instance transform with original node transform
      const combinedMatrix = _tempMatrix.clone().multiply(originalMatrix);
      instancedMesh.setMatrixAt(index, _tempMatrix);
    }
  }

  /**
   * Update visible instance counts for all meshes
   */
  _updateMeshCounts() {
    const visibleCount = this.instanceData.size;
    for (const instancedMesh of this.instancedMeshes) {
      instancedMesh.count = this.instanceCount;
    }
  }

  /**
   * Apply pending updates to GPU
   * Call this after batch updates for best performance
   */
  update() {
    if (!this._needsUpdate) return;

    for (const instancedMesh of this.instancedMeshes) {
      instancedMesh.instanceMatrix.needsUpdate = true;
      if (instancedMesh.instanceColor) {
        instancedMesh.instanceColor.needsUpdate = true;
      }
    }

    this._needsUpdate = false;
  }

  /**
   * Set color for a specific instance (if per-instance colors are needed)
   * @param {number} instanceId 
   * @param {THREE.Color|string|number} color 
   */
  setColor(instanceId, color) {
    const data = this.instanceData.get(instanceId);
    if (!data) return false;

    const threeColor = color instanceof THREE.Color ? color : new THREE.Color(color);

    for (const instancedMesh of this.instancedMeshes) {
      // Initialize instance color buffer if needed
      if (!instancedMesh.instanceColor) {
        const colors = new Float32Array(this.maxCount * 3);
        colors.fill(1); // Default white
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      }
      instancedMesh.setColorAt(data.index, threeColor);
    }

    this._needsUpdate = true;
    return true;
  }

  /**
   * Get statistics about this factory
   */
  getStats() {
    return {
      maxCount: this.maxCount,
      activeInstances: this.instanceData.size,
      totalAllocated: this.instanceCount,
      recycledSlots: this.freeIndices.length,
      meshGroups: this.meshGroups.size
    };
  }

  /**
   * Dispose all resources
   */
  dispose() {
    // Remove from parent
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }

    // Dispose instanced meshes (but NOT geometry/material - they're shared)
    for (const instancedMesh of this.instancedMeshes) {
      // Only dispose the instance-specific buffers
      if (instancedMesh.instanceMatrix) {
        instancedMesh.instanceMatrix = null;
      }
      if (instancedMesh.instanceColor) {
        instancedMesh.instanceColor = null;
      }
    }

    this.instancedMeshes = [];
    this.meshGroups.clear();
    this.instanceData.clear();
    this.freeIndices = [];
    this.instanceCount = 0;

    console.log('[InstanceFactory] Disposed');
  }
}

/**
 * Create a clone with shared resources (fallback when instancing not possible)
 * Use this for skinned meshes, morph targets, or when per-instance materials are needed.
 * 
 * @param {THREE.Object3D} prototypeScene - The prototype scene to clone
 * @returns {THREE.Object3D} Clone with shared geometry/material/texture references
 */
export function cloneShared(prototypeScene) {
  const clone = prototypeScene.clone(true);

  // Traverse both in parallel and share resources
  const prototypeNodes = [];
  const cloneNodes = [];

  prototypeScene.traverse(node => prototypeNodes.push(node));
  clone.traverse(node => cloneNodes.push(node));

  for (let i = 0; i < prototypeNodes.length; i++) {
    const protoNode = prototypeNodes[i];
    const cloneNode = cloneNodes[i];

    if (protoNode.isMesh && cloneNode.isMesh) {
      // Share geometry (don't duplicate)
      cloneNode.geometry = protoNode.geometry;

      // Share materials (don't duplicate)
      if (Array.isArray(protoNode.material)) {
        cloneNode.material = protoNode.material; // Same array reference
      } else {
        cloneNode.material = protoNode.material; // Same material reference
      }
    }
  }

  return clone;
}

export default InstanceFactory;

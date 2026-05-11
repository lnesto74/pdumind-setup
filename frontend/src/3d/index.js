/**
 * Three.js 3D Optimization Module
 * 
 * This module provides memory-efficient rendering for DCIM 3D scenes
 * with thousands of identical objects (racks, PDUs, etc.)
 * 
 * USAGE GUIDE:
 * 
 * 1. INSTANCING (Recommended for identical objects):
 *    Use when you have many copies of the same model with only
 *    position/rotation/scale differences.
 *    
 *    ```js
 *    import { modelCache, InstanceFactory } from './3d';
 *    
 *    // Load once
 *    const prototype = await modelCache.get('/models/rack.glb');
 *    modelCache.acquire('/models/rack.glb');
 *    
 *    // Create factory for 2000 instances
 *    const factory = new InstanceFactory(prototype, 2000);
 *    factory.addToScene(scene);
 *    
 *    // Add instances
 *    for (let i = 0; i < 2000; i++) {
 *      factory.addInstance({ position: [i * 2, 0, 0] });
 *    }
 *    factory.update(); // Apply to GPU
 *    
 *    // Cleanup when done
 *    factory.dispose();
 *    modelCache.release('/models/rack.glb');
 *    ```
 * 
 * 2. CLONE WITH SHARED RESOURCES (Fallback):
 *    Use when instancing is not possible (skinned meshes, morph targets,
 *    unique materials per instance).
 *    
 *    ```js
 *    import { modelCache, cloneShared, acquireResources, disposeObject3D } from './3d';
 *    
 *    const prototype = await modelCache.get('/models/character.glb');
 *    
 *    // Clone with shared geometry/materials
 *    const clone = cloneShared(prototype.scene);
 *    acquireResources(clone); // Track references
 *    scene.add(clone);
 *    
 *    // Cleanup
 *    disposeObject3D(clone);
 *    ```
 * 
 * 3. DEBUG PANEL:
 *    ```js
 *    import { createDebugPanel } from './3d';
 *    const panel = createDebugPanel(renderer);
 *    
 *    // In animation loop:
 *    panel.update();
 *    ```
 * 
 * MEMORY RULES:
 * - Never load the same GLB multiple times - use modelCache
 * - Always dispose objects when removing from scene
 * - Use InstanceFactory for 10+ identical objects
 * - Monitor with debugPanel during development
 */

export { modelCache } from './ModelCache';
export { InstanceFactory, cloneShared } from './InstanceFactory';
export { 
  disposeObject3D, 
  disposeScene, 
  acquireResources, 
  refCounter, 
  getMemoryStats,
  forceGCHint 
} from './dispose';
export { DebugPanel, createDebugPanel, logMemoryStats } from './debugPanel';

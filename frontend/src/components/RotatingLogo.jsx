import React, { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { OBJLoader } from 'three-stdlib';
import { OrbitControls } from '@react-three/drei';

function LogoMesh(props) {
  const meshRef = useRef();
  // Load OBJ model from public folder path
  const obj = useLoader(OBJLoader, '/logo_clean_white.obj');
  // Center the geometry on load
  if (obj && !obj.userData.centered) {
    obj.traverse((child) => {
      if (child.geometry) {
        child.geometry.center();
      }
    });
    obj.userData.centered = true;
  }
  // Base speed between 0.6 and 1.8 rad/s (3x faster)
  const baseSpeed = useMemo(() => Math.random() * 1.2 + 0.6, []);
  // Store acceleration state
  const acceleration = useRef(1.0);

  useFrame((state, delta) => {
    if (meshRef.current) {
      // Randomly adjust acceleration every few frames
      if (Math.random() < 0.02) { // 2% chance each frame to change acceleration
        acceleration.current = Math.random() * 0.5 + 0.8; // Random acceleration between 0.8x and 1.3x
      }
      meshRef.current.rotation.y += delta * baseSpeed * acceleration.current;
    }
  });

  return <primitive ref={meshRef} object={obj} {...props} />;
}

export default function RotatingLogo({ className }) {
  return (
    <div className={className} style={{ width: 120, height: 120 }}>
      <Canvas
        camera={{ position: [0, 0, 200], fov: 45 }}
        style={{ background: 'transparent' }}
      >
        <Suspense fallback={null}>
          <ambientLight intensity={0.7} />
          <directionalLight position={[50, 50, 50]} intensity={0.8} />
          <LogoMesh scale={0.4} />
          {/* Optional controls if you want user interaction */}
          {/* <OrbitControls enableZoom={false} /> */}
        </Suspense>
      </Canvas>
    </div>
  );
}

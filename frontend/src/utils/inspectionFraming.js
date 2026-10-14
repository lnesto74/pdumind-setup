// Fit every bounding-box corner in the actual unobscured canvas.
export function fitInspectionFrame(dimensions, aspect, fov = 45, margin = 1.24, direction = [0,.1,-1]) {
  const normal=a=>a.map(v=>v/Math.hypot(...a));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
  const back=normal(direction),right=normal(cross([0,1,0],back)),up=cross(back,right);
  const vertical=Math.tan(fov*Math.PI/360),horizontal=vertical*Math.max(.01,aspect);
  let distance=.6;
  for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
    const p=[x*dimensions[0]/2,y*dimensions[1]/2,z*dimensions[2]/2];
    distance=Math.max(distance,dot(p,back)+Math.max(Math.abs(dot(p,right))/horizontal,Math.abs(dot(p,up))/vertical)*margin);
  }
  return distance;
}

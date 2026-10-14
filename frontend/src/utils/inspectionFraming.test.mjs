import assert from 'node:assert/strict';
import { fitInspectionFrame } from './inspectionFraming.js';
const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
const normal=a=>a.map(x=>x/Math.hypot(...a));
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
let count=0;
for(const dims of [[.6,2.12,1],[1.8,2.12,2.2],[12,1.867,14],[20,3,20]])
for(const aspect of [.2,.4,.7,1,1.6,2.5])
for(const direction of [[0,.1,-1],[0,.12,1],[.45,.22,-1],[.85,.48,-1]]){
 const distance=fitInspectionFrame(dims,aspect,45,1.24,direction), back=normal(direction), right=normal(cross([0,1,0],back)), up=cross(back,right), tan=Math.tan(Math.PI/8);
 for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
  const corner=[x*dims[0]/2,y*dims[1]/2,z*dims[2]/2],depth=distance-dot(corner,back);
  assert(depth>.05);assert(Math.abs(dot(corner,right)/(depth*tan*aspect))<1);assert(Math.abs(dot(corner,up)/(depth*tan))<1);count++;
 }
 assert.equal(dot([0,0,0],right),0);
}
assert(fitInspectionFrame([1,2,1],.4)>fitInspectionFrame([1,2,1],1.6),'Narrow canvas must move camera back');
console.log(`PASS: ${count} projected corners fit across front/rear/selected/overview, narrow canvases, open doors and halls.`);

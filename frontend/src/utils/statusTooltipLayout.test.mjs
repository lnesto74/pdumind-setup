import assert from 'node:assert/strict';
import {layoutStatusTooltip} from './statusTooltipLayout.js';
let count=0;
for(const [width,height] of [[453,771],[509,771],[980,664],[1280,720],[320,480]])
for(const naturalHeight of [130,260,600])
for(const rack of [{left:width*.35,right:width*.62,top:height*.22,bottom:height*.70},{left:width*.18,right:width*.80,top:height*.25,bottom:height*.66}]){
 const box=layoutStatusTooltip({width,height,rack,anchor:{x:width/2,y:rack.top},naturalHeight});
 assert(box.x>=0&&box.y>=0);assert(box.x+box.width<=width);assert(box.y+box.height<=height);
 if(box.side!=='edge')assert(box.x+box.width<=rack.left||box.x>=rack.right||box.y+box.height<=rack.top||box.y>=rack.bottom);
 count++;
}
console.log(`PASS: ${count} tooltip layouts remain in canvas and avoid cabinet bounds when room is available.`);

const clamp=(value,min,max)=>Math.max(min,Math.min(value,Math.max(min,max)));
// Keep the card outside the projected cabinet whenever screen space permits.
// Narrow screens use a shorter scrollable card above/below the rack.
export function layoutStatusTooltip({width,height,rack,anchor,naturalHeight=260}) {
  const gap=12,top=112,bottom=Math.max(top+60,height-72),preferredWidth=Math.min(260,width-24);
  const cardHeight=Math.min(300,naturalHeight,bottom-top);
  const spaces={right:width-gap-rack.right-gap,left:rack.left-gap*2,below:bottom-rack.bottom-gap,above:rack.top-gap-top};
  const candidates=[];
  for(const side of ['right','left']) {
    if(spaces[side]<180)continue;
    const w=Math.min(preferredWidth,spaces[side]);
    candidates.push({x:side==='right'?rack.right+gap:rack.left-gap-w,y:clamp(anchor.y+12,top,bottom-cardHeight),width:w,height:cardHeight,side,score:w*cardHeight});
  }
  for(const side of ['below','above']) {
    if(spaces[side]<96)continue;
    const h=Math.min(cardHeight,spaces[side]);
    candidates.push({x:clamp(anchor.x-preferredWidth/2,gap,width-gap-preferredWidth),y:side==='below'?rack.bottom+gap:rack.top-gap-h,width:preferredWidth,height:h,side,score:preferredWidth*h*.92});
  }
  // If the user has zoomed beyond the canvas, retain readable screen-space access.
  const best=candidates.sort((a,b)=>b.score-a.score)[0] || {x:width-gap-preferredWidth,y:bottom-Math.min(132,cardHeight),width:preferredWidth,height:Math.min(132,cardHeight),side:'edge'};
  return {...best,x:clamp(best.x,gap,width-gap-best.width),y:clamp(best.y,gap,height-gap-best.height)};
}

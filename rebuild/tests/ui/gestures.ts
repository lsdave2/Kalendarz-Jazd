import type {Page} from '@playwright/test';

export async function mouseDrag(page:Page,x:number,y:number,dx:number,dy:number){
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+dx,y+dy,{steps:12});await page.mouse.up();
}

// Use real browser touch input: this exercises native scroll/pointer cancellation.
export async function touchDrag(page:Page,x:number,y:number,dx:number,dy:number,holdMs=0){
  const session=await page.context().newCDPSession(page);
  try{
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    if(holdMs)await page.waitForTimeout(holdMs);
    for(let i=1;i<=12;i++)await session.send('Input.dispatchTouchEvent',{
      type:'touchMove',touchPoints:[{x:x+dx*i/12,y:y+dy*i/12}],
    });
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }finally{await session.detach();}
}

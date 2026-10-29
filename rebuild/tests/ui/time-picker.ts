import type {Locator,Page} from '@playwright/test';

export async function chooseTime(scope:Page|Locator,label:string,time:string){
  const [hour,minute]=time.split(':');
  await scope.getByRole('button',{name:label,exact:true}).click();
  await scope.getByRole('listbox',{name:/^(Godziny|Hours)$/}).getByRole('option',{name:hour,exact:true}).click();
  await scope.getByRole('listbox',{name:/^(Minuty|Minutes)$/}).getByRole('option',{name:minute,exact:true}).click();
  await scope.getByRole('button',{name:/^(Gotowe|Done)$/}).click();
}

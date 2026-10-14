import {test,expect} from '@playwright/test';

test('add, edit and clear a client phone number across reloads',async({page})=>{
  await page.goto('/#accounts');
  await page.getByRole('button',{name:'Klienci',exact:true}).click();
  await page.getByRole('button',{name:'Dodaj',exact:true}).click();
  let modal=page.getByRole('dialog');
  await modal.getByLabel('Nazwa',{exact:true}).fill('Phone UI client');
  await modal.getByLabel('Numer telefonu (opcjonalnie)').fill('+48 012 345 678');
  await modal.getByRole('button',{name:'Zapisz',exact:true}).click();
  await expect(modal).toHaveCount(0);
  await page.reload();
  const card=page.locator('.package-card').filter({hasText:'Phone UI client'});
  await expect(card).toContainText('+48 012 345 678');
  await card.getByRole('button',{name:'Edytuj: Phone UI client',exact:true}).click();
  modal=page.getByRole('dialog');
  await expect(modal.getByLabel('Numer telefonu (opcjonalnie)')).toHaveValue('+48 012 345 678');
  await modal.getByLabel('Numer telefonu (opcjonalnie)').fill('00123 456');
  await modal.getByRole('button',{name:'Zapisz',exact:true}).click();
  await expect(card).toContainText('00123 456');
  await card.getByRole('button',{name:'Edytuj: Phone UI client',exact:true}).click();
  await page.getByLabel('Numer telefonu (opcjonalnie)').fill('');
  await page.getByRole('button',{name:'Zapisz',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(card).not.toContainText('00123 456');
  await card.getByRole('button',{name:'Edytuj: Phone UI client',exact:true}).click();
  await expect(page.getByLabel('Numer telefonu (opcjonalnie)')).toHaveValue('');
});

import { firefox } from "playwright";

export async function scrapeMarketplace(searchQuery, location = 'montevideo') {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();

  // URL de búsqueda en Facebook Marketplace
  const url = `https://www.facebook.com/marketplace/${location}/search/?query=${searchQuery}`;

  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForSelector('a[href*="/marketplace/item/"]');

  const items = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')).map(item => {
      return {
        title: item.innerText || null,
        link: item.href || null
      }
    });
  });

  let previousHeight;
  for(let i = 0; i < 5; i++){
    previousHeight = await page.evaluate('document.body.scrollHeight');
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await page.waitForTimeout(2000);
    const newHeight = await page.evaluate('document.body.scrollHeight');
    if(newHeight === previousHeight) break;
  }

  return items;
}

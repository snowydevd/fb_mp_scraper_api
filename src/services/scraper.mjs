import { firefox } from "playwright";

export async function scrapeMarketplace(searchQuery, location = 'montevideo', minPrice, maxPrice) {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage();

  // URL de búsqueda en Facebook Marketplace
  const url = `https://www.facebook.com/marketplace/${location}/search/?query=${searchQuery}`;

  await page.goto(url, { waitUntil: "networkidle" });

  await page.waitForSelector('a[href*="/marketplace/item/"]');

    const items = await page.evaluate(({ minPrice, maxPrice }) => {
      return Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')).map(item => {
        let text = item.innerText.split(/\r?\n/);

        let price = null;
        let oldPrice = null;
        let title = null;

        // Si el segundo valor parece un número/precio, significa que hay oferta
        if (text[1] && text[1].match(/\$\d/)) {
          price = text[0] || null;       // precio actual
          oldPrice = text[1] || null;    // precio anterior
          title = text[2] || null;
        } else {
          price = text[0] || null;       // precio único
          title = text[1] || null;
        }

        price = parseInt(price?.replace(/[^\d]/g, '')) || null;

        minPrice = parseInt(minPrice) || 0;
        maxPrice = parseInt(maxPrice) || Infinity;

        // if(minPrice > price || price > maxPrice) return null;

        // if (keywords.length > 0) {
        //   const itemText = text.join(" ").toLowerCase();
        //   const hasKeyword = Array.isArray(keywords)
        //     ? keywords.some(keyword => itemText.includes(keyword.toLowerCase()))
        //     : keywords.split(',').some(keyword => itemText.includes(keyword.toLowerCase()));
        //   if (!hasKeyword) return null;
        // }



        return {
          title,
          price,
          oldPrice,
          thumbnail: item.querySelector('img')?.src || null,
          link: item.href || null,
          // key_words: newKeywords,
          raw: text 
        }
      });
  }, { minPrice, maxPrice});

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

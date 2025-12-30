import { chromium } from "playwright";
// Remove fetch, use broadcastDeal for SSE
// import { broadcastDeal } from "../routes/marketplace.mjs";



export async function scrapeMarketplace(searchQuery, location = 'montevideo', minPrice, maxPrice) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // URL de búsqueda en Facebook Marketplace
    const url = `https://www.facebook.com/marketplace/${location}/search/?query=${searchQuery}`;

    await page.goto(url, { waitUntil: "networkidle" });

    // Scroll first to load more items
    let previousHeight;
    for (let i = 0; i < 5; i++) {
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await page.waitForTimeout(2000);
      const newHeight = await page.evaluate('document.body.scrollHeight');
      if (newHeight === previousHeight) break;
    }

    await page.waitForSelector('a[href*="/marketplace/item/"]');

    const items = await page.evaluate(({ minPrice, maxPrice }) => {
      return Array.from(document.querySelectorAll('a[href*="/marketplace/item/"]')).map(item => {
        // Get the parent container that usually holds the text
        const container = item.closest('div[style*="max-width"]') || item;
        const text = container.innerText.split(/\r?\n/).filter(t => t.trim() !== '');

        let price = null;
        let title = null;
        let oldPrice = null;

        // Heuristic: Look for price patterns
        const isPrice = (s) => s && /[\$€£U\$S]/.test(s) && /\d/.test(s);

        if (text.length > 0) {
          if (isPrice(text[0])) {
            price = text[0];
            if (text.length > 1 && isPrice(text[1])) {
              oldPrice = text[1];
              title = text[2] || null;
            } else {
              title = text[1] || null;
            }
          } else {
            // Maybe title is first?
            title = text[0];
            if (text.length > 1 && isPrice(text[1])) {
              price = text[1];
            }
          }
        }

        // Fallback to aria-label for title if not found
        if (!title) {
          const ariaLabel = item.getAttribute('aria-label');
          if (ariaLabel) title = ariaLabel;
        }

        price = parseInt(price?.replace(/[^\d]/g, '')) || null;


        return {
          title,
          price,
          oldPrice,
          thumbnail: item.querySelector('img')?.src || null,
          link: item.href || null,
          raw: text
        }
      });
    }, { minPrice, maxPrice });

    const filteredItems = items.filter(item => item.price !== null && item.price >= minPrice && item.price <= maxPrice);

    return filteredItems;
  } catch (error) {
    console.error("Error in scrapeMarketplace:", error);
    throw error;
  } finally {
    await browser.close();
  }
}


const seen = new Set();


async function scrapeDeals() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // TODO: Replace with your actual search URL and parameters
    await page.goto("https://www.facebook.com/marketplace/sydney/search/?query=laptop");

    // Example: get titles & prices
    const deals = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="article"]')).map(el => {
        const title = el.innerText;
        const price = el.innerText.match(/\$[0-9,.]+/);
        return { title, price };
      });
    });

    for (const deal of deals) {
      if (!seen.has(deal.title)) {
        seen.add(deal.title);

        // Filter: below $5000
        const numPrice = parseInt(deal.price?.replace(/\$|,/g, ""));
        if (numPrice && numPrice < 5000) {
          // Broadcast to SSE clients
          broadcastDeal({
            title: deal.title,
            price: numPrice,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error in scrapeDeals:", error);
  } finally {
    await browser.close();
  }
}

// Run every X minutes
// setInterval(scrapeDeals, 30 * 1000);

import {Router} from "express"
import {scrapeMarketplace} from "../services/scraper.mjs"
import cors from 'cors'

const router = Router();
router.use(cors())

let clients = [];

router.get('/', async (req, res) => {
    let { query, location, minPrice, maxPrice } = req.query

    if(!query) return res.status(400).json({ error: "Query parameter is required"});
    try {
        minPrice = parseInt(minPrice) || 0;
        maxPrice = parseInt(maxPrice) || 9999999;
        console.log(minPrice, maxPrice)
        const results = await scrapeMarketplace(query, location, minPrice, maxPrice);
        res.json(results);
    } catch (error) {
        console.error("Error occurred while scraping: ", error);
        res.status(500).json({ error: "An error occurred while scraping: " + error.message });
    }
});


// SSE endpoint: client connects and receives deals as they appear
router.get('/stream-deals', (req, res) => {
        const { price } = req.query;
        const targetPrice = price ? parseInt(price) : null;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const client = { res, targetPrice };
        clients.push(client);

        console.log('Searching new good deals')
        req.on('close', () => {
                clients = clients.filter(c => c.res !== res);
        });
});

// Broadcast deals to clients matching the price
export function broadcastDeal(deal) {
    for (const client of clients) {
        if (!client.targetPrice || deal.price <= client.targetPrice) {
            client.res.write(`data: ${JSON.stringify(deal)}\n\n`);
        }
    }
}

export default router;

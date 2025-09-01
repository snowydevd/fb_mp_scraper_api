import {Router} from "express"
import {scrapeMarketplace} from "../services/scraper.mjs"

const router = Router();


router.get('/', async (req, res) => {
    const { query, location, minPrice, maxPrice } = req.query

    if(!query) return res.status(400).json({ error: "Query parameter is required"});

    try {
        console.log(minPrice, maxPrice)
        const results = await scrapeMarketplace(query, location, minPrice, maxPrice);
        res.json(results);
    } catch (error) {
        console.error("Error occurred while scraping:", error);
        res.status(500).json({ error: "An error occurred while scraping" + error.message });
    }

});

export default router;

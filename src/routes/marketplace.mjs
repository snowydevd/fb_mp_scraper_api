import {Router} from "express"
import {scrapeMarketplace} from "../services/scraper.mjs"

const router = Router();


router.get('/', async (req, res) => {
    const { query, location } = req.query

    if(!query) return res.status(400).json({ error: "Query parameter is required"});

    try {
        const results = await scrapeMarketplace(query, location);
        res.json(results);
    } catch (error) {
        console.error("Error occurred while scraping:", error);
        res.status(500).json({ error: "An error occurred while scraping" });
    }

});

export default router;

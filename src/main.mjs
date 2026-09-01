import express from "express";
import cors from "cors";
import marketplaceRoutes from "./routes/marketplace.mjs";
import opportunityRoutes from "./routes/opportunities.mjs";
import { closeBrowser } from "./services/scraper.mjs";

const app = express();
app.use(express.json());
app.use(cors());

app.use("/api/marketplace", marketplaceRoutes);
app.use("/api/opportunities", opportunityRoutes);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function shutdown() {
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

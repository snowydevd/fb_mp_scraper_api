import express from "express"   
import marketplaceRoutes from "./routes/marketplace.mjs"


const app = express();
app.use(express.json());

app.use("/api/marketplace", marketplaceRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
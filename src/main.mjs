import express from "express"   
import marketplaceRoutes from "./routes/marketplace.mjs"
import cors from 'cors'

const app = express();
app.use(express.json());
app.use(cors());

app.use("/api/marketplace", marketplaceRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
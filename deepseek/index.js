import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { obtenerRespuesta } from './deepseek.js';
import { generarOpinionBreve } from './deepseek.js';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  try {
    const respuesta = await obtenerRespuesta(message);
    res.json({ response: respuesta });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener respuesta de Deepseek' });
  }
});


app.post('/api/opinion', async (req, res) => {
  const { question, answer } = req.body;
  try {
    const opinion = await generarOpinionBreve(question, answer);
    res.json({ response: opinion });
  } catch (error) {
    res.status(500).json({ error: 'Error generando opinión breve' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
